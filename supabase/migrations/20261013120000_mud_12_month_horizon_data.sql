-- MUD bookings 12 months ahead, PR-A (WMRC, Jared Crowe 12/10/2026; ADR 0029).
--
-- Verco's MUD booking page already looks 365 days ahead, but collection dates
-- are only generated 16 weeks out, MUD days in unpooled areas are ticked by hand,
-- there is no FY28 row, and every booking is filed under the CURRENT FY
-- regardless of its collection date. This migration lays the data + RPC ground;
-- PR-B extends the generator (it reads the new column, so it ships after this
-- release and the types regen — CLAUDE.md §21 Types Freshness split).
--
-- 1. FY28 row (financial_year has no unique key, so guard on overlap).
-- 2. Remaining 2027 WA public holidays from the official wa.gov.au table.
--    2028 is NOT seeded: the WA Government hasn't published it (13/10/2026).
-- 3. collection_schedule.mud_weeks: which occurrences of a schedule weekday in
--    a month are MUD days (1 = first … 5 = fifth). NULL = staff curate MUD days
--    by hand (today's behaviour). Seeded to {1..5} only where every collection
--    day is already a MUD day in practice (CAM-A, CAM-B, EAS, FRE-S, SOP, SUB,
--    VIC — audited 13/10). VIN and Kwinana stay NULL: deliberate cadences.
--    Pooled areas ignore it (MUDs book any open date, #558).
-- 4. create_mud_booking / create_id_booking take the FY of the COLLECTION date.
--    Bodies are the live prod bodies (md5-verified 13/10) with only the FY
--    lookup changed; the ID RPC's search_path pin gains pg_temp.

-- 1 ───────────────────────────────────────────────────────────────────────────
INSERT INTO financial_year (label, start_date, end_date, rollover_date, is_current)
SELECT 'FY28', DATE '2027-07-01', DATE '2028-06-30', DATE '2027-07-01', false
WHERE NOT EXISTS (
  SELECT 1 FROM financial_year
  WHERE label = 'FY28'
     OR (start_date <= DATE '2028-06-30' AND end_date >= DATE '2027-07-01')
);

-- 2 ───────────────────────────────────────────────────────────────────────────
-- Weekday holidays only (weekend ones never carry a collection), named like the
-- existing rows.
INSERT INTO public_holiday (date, name, jurisdiction) VALUES
  ('2027-09-27', 'King''s Birthday', 'WA'),
  ('2027-12-27', 'Christmas Day (observed)', 'WA'),
  ('2027-12-28', 'Boxing Day (observed)', 'WA')
ON CONFLICT (jurisdiction, date) DO NOTHING;

-- 3 ───────────────────────────────────────────────────────────────────────────
ALTER TABLE collection_schedule ADD COLUMN IF NOT EXISTS mud_weeks smallint[];

ALTER TABLE collection_schedule
  ADD CONSTRAINT collection_schedule_mud_weeks_valid CHECK (
    mud_weeks IS NULL
    OR (cardinality(mud_weeks) > 0 AND mud_weeks <@ ARRAY[1, 2, 3, 4, 5]::smallint[])
  );

COMMENT ON COLUMN collection_schedule.mud_weeks IS
  'Occurrences of this weekday within a month that the date generator flags for_mud (1 = first … 5 = fifth). NULL = staff curate MUD days by hand. Ignored for pooled areas (MUDs book any open date).';

-- No-op on a fresh db reset (VV areas are not seeded before migrations run).
UPDATE collection_schedule cs
SET mud_weeks = ARRAY[1, 2, 3, 4, 5]::smallint[]
FROM collection_area ca
WHERE ca.id = cs.collection_area_id
  AND ca.capacity_pool_id IS NULL
  AND ca.code IN ('CAM-A', 'CAM-B', 'EAS', 'FRE-S', 'SOP', 'SUB', 'VIC')
  AND cs.mud_weeks IS NULL;

-- 4 ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_mud_booking_with_capacity_check(
  p_property_id uuid,
  p_collection_date_id uuid,
  p_items jsonb,
  p_notes text DEFAULT ''::text,
  p_terms_accepted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_mud          boolean;
  v_is_eligible     boolean;
  v_onboarding      text;
  v_contact_id      uuid;
  v_location        text;
  v_area_id         uuid;
  v_client_id       uuid;
  v_contractor_id   uuid;
  v_area_code       text;
  v_pool_id         uuid;
  v_fy_id           uuid;
  v_date            date;
  v_pool_date_id    uuid;
  v_lock_key        bigint;
  v_terms           text;
  v_terms_version   int;
  v_has_terms       boolean;
  v_item            jsonb;
  v_cat_code        text;
  v_units_requested integer;
  v_bulk_requested  integer := 0;
  v_anc_requested   integer := 0;
  v_id_requested    integer := 0;
  v_bulk_available  integer;
  v_anc_available   integer;
  v_id_available    integer;
  v_ref             text;
  v_booking_id      uuid;
BEGIN
  -- Office staff create MUD bookings on behalf of the strata contact. NULL-safe
  -- (a caller with no active role has current_user_role() = NULL).
  IF (current_user_role() IN (
    'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only staff roles can create MUD bookings';
  END IF;

  -- Property must be an eligible, Registered MUD with a strata contact. Derive
  -- its area + contact server-side — never trust the caller for tenant
  -- attribution.
  SELECT ep.is_mud, ep.is_eligible, ep.mud_onboarding_status, ep.strata_contact_id,
         ep.waste_location_notes, ep.collection_area_id
  INTO v_is_mud, v_is_eligible, v_onboarding, v_contact_id, v_location, v_area_id
  FROM eligible_properties ep
  WHERE ep.id = p_property_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property not found';
  END IF;
  IF v_is_mud IS NOT TRUE THEN
    RAISE EXCEPTION 'Property is not a MUD';
  END IF;
  IF v_is_eligible IS NOT TRUE THEN
    RAISE EXCEPTION 'Property is not eligible for collection bookings';
  END IF;
  IF v_onboarding IS DISTINCT FROM 'Registered' THEN
    RAISE EXCEPTION 'MUD must be in Registered status to create bookings';
  END IF;
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'MUD has no strata contact';
  END IF;
  IF v_area_id IS NULL THEN
    RAISE EXCEPTION 'MUD has no collection area';
  END IF;

  -- Area must be active (WS-A staged go-live gate). Derive tenant + area code.
  SELECT ca.client_id, ca.contractor_id, ca.code, ca.capacity_pool_id
  INTO v_client_id, v_contractor_id, v_area_code, v_pool_id
  FROM collection_area ca
  WHERE ca.id = v_area_id AND ca.is_active;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Collection area is not open for bookings';
  END IF;

  -- Tenant scope: caller must have access to the area's client.
  IF v_client_id NOT IN (SELECT accessible_client_ids()) THEN
    RAISE EXCEPTION 'Collection area is outside your accessible clients';
  END IF;

  -- Sub-client scope (VER-216). NULL narrowing passes.
  IF NOT user_sub_client_allows_area(v_area_id) THEN
    RAISE EXCEPTION 'Collection area is outside your sub-client scope';
  END IF;

  -- FY follows the COLLECTION date, not today: MUD bookings now run 12 months
  -- out, so a booking for after 30 June belongs to the next FY (13/10/2026).
  SELECT fy.id INTO v_fy_id
  FROM collection_date cd
  JOIN financial_year fy ON cd.date BETWEEN fy.start_date AND fy.end_date
  WHERE cd.id = p_collection_date_id
  ORDER BY fy.start_date DESC
  LIMIT 1;
  IF v_fy_id IS NULL THEN
    RAISE EXCEPTION 'No financial year covers this collection date';
  END IF;

  -- Collection date must belong to the area, be MUD-enabled, open, and not past
  -- (AWST calendar date).
  SELECT cd.date INTO v_date
  FROM collection_date cd
  WHERE cd.id = p_collection_date_id
    AND cd.collection_area_id = v_area_id
    -- Pooled areas accept MUDs on any open date (#558 option 2); unpooled
    -- councils keep the curated for_mud dedicated-MUD-day model.
    AND (v_pool_id IS NOT NULL OR cd.for_mud)
    AND cd.is_open
    AND cd.date >= (now() AT TIME ZONE 'Australia/Perth')::date;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection date is not available for MUD bookings';
  END IF;

  -- T&Cs gate (mirrors create_booking_with_capacity_check). Empty/whitespace
  -- terms => skipped; text is snapshotted server-side, caller passes only the
  -- boolean.
  SELECT terms_markdown, terms_version INTO v_terms, v_terms_version
  FROM client WHERE id = v_client_id;
  v_has_terms := COALESCE(v_terms ~ '\S', false);

  IF v_has_terms AND NOT p_terms_accepted THEN
    RAISE EXCEPTION 'Terms and Conditions must be accepted before booking'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Capacity (mirrors create_booking_with_capacity_check) ─────────────────
  IF v_pool_id IS NOT NULL THEN
    SELECT id INTO v_pool_date_id
    FROM collection_date_pool
    WHERE capacity_pool_id = v_pool_id AND date = v_date;
    IF v_pool_date_id IS NULL THEN
      RAISE EXCEPTION 'No collection_date_pool row for pool % on date %', v_pool_id, v_date;
    END IF;
    v_lock_key := ('x' || substr(v_pool_date_id::text, 1, 8))::bit(32)::bigint;
  ELSE
    v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  END IF;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_cat_code := v_item->>'category_code';
    v_units_requested := (v_item->>'no_services')::integer;
    CASE v_cat_code
      WHEN 'bulk' THEN v_bulk_requested := v_bulk_requested + v_units_requested;
      WHEN 'anc'  THEN v_anc_requested  := v_anc_requested  + v_units_requested;
      WHEN 'id'   THEN v_id_requested   := v_id_requested   + v_units_requested;
    END CASE;
  END LOOP;

  IF v_pool_id IS NOT NULL THEN
    SELECT bulk_capacity_limit - bulk_units_booked,
           anc_capacity_limit  - anc_units_booked,
           id_capacity_limit   - id_units_booked
    INTO v_bulk_available, v_anc_available, v_id_available
    FROM collection_date_pool WHERE id = v_pool_date_id;
  ELSE
    SELECT bulk_capacity_limit - bulk_units_booked,
           anc_capacity_limit  - anc_units_booked,
           id_capacity_limit   - id_units_booked
    INTO v_bulk_available, v_anc_available, v_id_available
    FROM collection_date WHERE id = p_collection_date_id;
  END IF;

  IF v_bulk_requested > 0 AND v_bulk_available < v_bulk_requested THEN
    RAISE EXCEPTION 'Insufficient bulk capacity on collection date';
  END IF;
  IF v_anc_requested > 0 AND v_anc_available < v_anc_requested THEN
    RAISE EXCEPTION 'Insufficient ancillary capacity on collection date';
  END IF;
  IF v_id_requested > 0 AND v_id_available < v_id_requested THEN
    RAISE EXCEPTION 'Insufficient illegal dumping capacity on collection date';
  END IF;

  v_ref := generate_booking_ref(v_area_code);

  INSERT INTO booking (
    ref, status, type, property_id, contact_id, collection_area_id,
    client_id, contractor_id, fy_id, location, notes, created_by, created_via,
    terms_accepted_at, terms_accepted_text, terms_version,
    terms_accepted_by, terms_accepted_channel
  ) VALUES (
    v_ref, 'Confirmed'::booking_status, 'MUD'::booking_type,
    p_property_id, v_contact_id, v_area_id,
    v_client_id, v_contractor_id, v_fy_id, v_location, p_notes, auth.uid(), 'admin',
    CASE WHEN v_has_terms THEN now()           ELSE NULL END,
    CASE WHEN v_has_terms THEN v_terms         ELSE NULL END,
    CASE WHEN v_has_terms THEN v_terms_version ELSE NULL END,
    CASE WHEN v_has_terms THEN auth.uid()      ELSE NULL END,
    CASE WHEN v_has_terms THEN 'mud_admin'     ELSE NULL END
  )
  RETURNING id INTO v_booking_id;

  -- MUD units are always free + not extra (placeholders for the closeout).
  INSERT INTO booking_item (
    booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra
  )
  SELECT
    v_booking_id,
    (item->>'service_id')::uuid,
    p_collection_date_id,
    (item->>'no_services')::integer,
    0,
    false
  FROM jsonb_array_elements(p_items) AS item;

  RETURN jsonb_build_object('booking_id', v_booking_id, 'ref', v_ref);
END;
$function$;

CREATE OR REPLACE FUNCTION create_id_booking_with_capacity_check(
  p_collection_date_id uuid,
  p_collection_area_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_geo_address text,
  p_notes text,
  p_photos text[],
  p_waste_types text[],
  p_volume text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_lock_key            bigint;
  v_client_id           uuid;
  v_contractor_id       uuid;
  v_area_code           text;
  v_pool_id             uuid;
  v_pool_date_id        uuid;
  v_pool_id_closed      boolean;
  v_fy_id               uuid;
  v_service_id          uuid;
  v_id_available        integer;
  v_booking_id          uuid;
  v_ref                 text;
  v_is_contractor_admin boolean;
  v_may_book_locked     boolean;
  v_pool_locked         boolean;
  v_contact_id          uuid;
BEGIN
  -- Rangers (field intake) and office staff (admin portal) create ID bookings.
  IF (current_user_role() IN (
    'ranger', 'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only ranger and staff roles can create illegal dumping bookings';
  END IF;

  -- Contractor-admins may book closed-but-not-full dates (capacity still holds).
  v_is_contractor_admin := current_user_role() = 'contractor-admin';

  -- Office + council staff may book a date the T-3 lock closed, as long as it
  -- is otherwise open and not full (WMRC 3-day ask). Rangers are excluded.
  v_may_book_locked := current_user_role() IN (
    'contractor-staff', 'client-admin', 'client-staff'
  );

  -- Derive tenant + area code from the area itself — never trust the caller.
  SELECT ca.client_id, ca.contractor_id, ca.code, ca.capacity_pool_id
  INTO v_client_id, v_contractor_id, v_area_code, v_pool_id
  FROM collection_area ca
  WHERE ca.id = p_collection_area_id AND ca.is_active;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Collection area not found';
  END IF;

  -- Enforce tenant scope.
  IF v_client_id NOT IN (SELECT accessible_client_ids()) THEN
    RAISE EXCEPTION 'Collection area is outside your accessible clients';
  END IF;

  -- Enforce sub-client scope (VER-216). NULL narrowing passes.
  IF NOT user_sub_client_allows_area(p_collection_area_id) THEN
    RAISE EXCEPTION 'Collection area is outside your sub-client scope';
  END IF;

  -- The collection date must belong to the area.
  PERFORM 1 FROM collection_date
  WHERE id = p_collection_date_id AND collection_area_id = p_collection_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection date does not belong to the collection area';
  END IF;

  -- 3:00pm cut-off, ahead of the per-role branches because it binds all of them.
  -- Perth wall-clock on both sides; WA has no daylight saving.
  PERFORM 1 FROM collection_date cd
  WHERE cd.id = p_collection_date_id
    AND (now() AT TIME ZONE 'Australia/Perth')
        < (cd.date - interval '1 day' + interval '15 hours');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bookings for that date closed at 3:00pm the day before';
  END IF;

  -- Date validity. Every role: not in the past (AWST calendar date). Standard
  -- roles additionally require the date to be open and not ID-closed (covers
  -- the T-3 hard close and admin lock). Contractor-admins skip the closure
  -- checks — capacity below still gates them — so they can schedule onto a
  -- closed date that still has room.
  IF v_is_contractor_admin THEN
    PERFORM 1 FROM collection_date
    WHERE id = p_collection_date_id
      AND date >= (now() AT TIME ZONE 'Australia/Perth')::date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Collection date is in the past';
    END IF;
  ELSIF v_may_book_locked THEN
    -- Open, not in the past, and closed only by the T-3 lock (if at all).
    -- A full date passes here and is refused by the capacity check below.
    PERFORM 1 FROM collection_date
    WHERE id = p_collection_date_id
      AND is_open
      AND (NOT id_is_closed OR locked_closed)
      AND date >= (now() AT TIME ZONE 'Australia/Perth')::date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Collection date is closed for illegal dumping bookings';
    END IF;
  ELSE
    PERFORM 1 FROM collection_date
    WHERE id = p_collection_date_id
      AND is_open
      AND NOT id_is_closed
      AND date >= (now() AT TIME ZONE 'Australia/Perth')::date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Collection date is closed for illegal dumping bookings';
    END IF;
  END IF;

  -- FY follows the COLLECTION date, not today: MUD bookings now run 12 months
  -- out, so a booking for after 30 June belongs to the next FY (13/10/2026).
  SELECT fy.id INTO v_fy_id
  FROM collection_date cd
  JOIN financial_year fy ON cd.date BETWEEN fy.start_date AND fy.end_date
  WHERE cd.id = p_collection_date_id
  ORDER BY fy.start_date DESC
  LIMIT 1;
  IF v_fy_id IS NULL THEN
    RAISE EXCEPTION 'No financial year covers this collection date';
  END IF;

  -- Single ID service stream (PRD §4.2).
  SELECT s.id INTO v_service_id
  FROM service s
  JOIN category c ON c.id = s.category_id
  WHERE c.code = 'id' AND s.is_active
  LIMIT 1;
  IF v_service_id IS NULL THEN
    RAISE EXCEPTION 'Illegal dumping service is not configured';
  END IF;

  -- Serialise concurrent bookings: pooled areas lock + count on the pool row
  -- (same key scheme as create_booking_with_capacity_check), per-date areas
  -- on the collection_date row.
  IF v_pool_id IS NOT NULL THEN
    SELECT cdp.id INTO v_pool_date_id
    FROM collection_date_pool cdp
    JOIN collection_date cd ON cd.id = p_collection_date_id
    WHERE cdp.capacity_pool_id = v_pool_id AND cdp.date = cd.date;

    IF v_pool_date_id IS NULL THEN
      RAISE EXCEPTION 'No capacity pool date exists for this collection date';
    END IF;

    v_lock_key := ('x' || substr(v_pool_date_id::text, 1, 8))::bit(32)::bigint;
  ELSE
    v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  END IF;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF v_pool_id IS NOT NULL THEN
    SELECT id_capacity_limit - id_units_booked, id_is_closed, locked_closed
    INTO v_id_available, v_pool_id_closed, v_pool_locked
    FROM collection_date_pool
    WHERE id = v_pool_date_id;

    -- Same three tiers as the per-date gate above: contractor-admin overrides
    -- any closure, office/council staff override a lock-only closure, everyone
    -- else is refused. Capacity below still stops a full pool date.
    IF v_pool_id_closed
       AND NOT v_is_contractor_admin
       AND NOT (v_may_book_locked AND v_pool_locked) THEN
      RAISE EXCEPTION 'Collection date is closed for illegal dumping bookings';
    END IF;
  ELSE
    SELECT id_capacity_limit - id_units_booked
    INTO v_id_available
    FROM collection_date
    WHERE id = p_collection_date_id;
  END IF;

  IF v_id_available IS NULL THEN
    RAISE EXCEPTION 'Collection date not found';
  END IF;

  IF v_id_available < 1 THEN
    RAISE EXCEPTION 'No illegal dumping capacity remaining on this date';
  END IF;

  v_ref := generate_booking_ref(v_area_code);

  -- Link the logging user's own contact (staff all have one; ranger without a
  -- linked contact → NULL, unchanged). Shows who logged the collection in the
  -- booking detail. No notifications result — dispatch skips Illegal Dumping.
  v_contact_id := COALESCE(current_user_contact_id(), current_user_contact_id_by_email());

  INSERT INTO booking (
    ref, type, status, collection_area_id, client_id, contractor_id, fy_id,
    latitude, longitude, geo_address, notes, photos, id_waste_types, id_volume,
    created_by, contact_id
  ) VALUES (
    v_ref, 'Illegal Dumping', 'Confirmed', p_collection_area_id, v_client_id, v_contractor_id, v_fy_id,
    p_latitude, p_longitude, p_geo_address, p_notes,
    COALESCE(p_photos, '{}'), COALESCE(p_waste_types, '{}'), p_volume,
    auth.uid(), v_contact_id
  )
  RETURNING id INTO v_booking_id;

  -- One free unit; the recalc trigger on booking_item bumps id_units_booked
  -- (on collection_date_pool for pooled areas, collection_date otherwise).
  INSERT INTO booking_item (
    booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra
  ) VALUES (
    v_booking_id, v_service_id, p_collection_date_id, 1, 0, false
  );

  RETURN jsonb_build_object('booking_id', v_booking_id, 'ref', v_ref);
END;
$function$;
