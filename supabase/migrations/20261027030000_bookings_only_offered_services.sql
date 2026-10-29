-- A booking may only include services its collection area offers.
--
-- Pricing (calculatePrice) reads a service with no service_rules row for the
-- area as 0 free units at a $0 extra price. The resident UI only lists the
-- area's own rules, but none of the three booking RPCs checked, so a
-- hand-crafted create-booking request could book an un-offered service for $0:
-- e.g. a Mattress in Town of Cambridge or Town of Victoria Park, which offer
-- none (WMRC question, 27/10/2026). No such booking exists in prod: every
-- Residential/MUD booking_item matches a rule (checked read-only 27/10;
-- Illegal Dumping items use create_id_booking_with_capacity_check, which picks
-- the ID service itself and is untouched here).
--
-- Each RPC is redefined from its current text (hash-matched against prod on
-- 27/10) with one gate added. Same signatures, so existing grants and comments
-- carry over; SET search_path is re-declared because CREATE OR REPLACE resets
-- it otherwise. The create-booking Edge Function gives the early, friendly
-- 400 (_shared/service-gate-server.ts); these are the enforcement.
--
-- update_booking_items_in_place: an edit may keep or reduce a service already
-- on the booking even if its rule was later removed, so a staff reduction that
-- owes a refund still goes through.

-- ── 1. Resident create (create-booking EF, service-role caller) ────────────
CREATE OR REPLACE FUNCTION public.create_booking_with_capacity_check(
  p_collection_date_id uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_collection_area_id uuid,
  p_client_id uuid,
  p_contractor_id uuid,
  p_fy_id uuid,
  p_area_code text,
  p_location text,
  p_notes text,
  p_status text,
  p_items jsonb,
  p_actor_id uuid DEFAULT NULL::uuid,
  p_type text DEFAULT 'Residential'::text,
  p_terms_accepted boolean DEFAULT false,
  p_terms_channel text DEFAULT NULL::text,
  p_created_via text DEFAULT 'system'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool_id         uuid;
  v_date            date;
  v_pool_date_id    uuid;
  v_lock_key        bigint;
  v_booking_id      uuid;
  v_ref             text;
  v_item            jsonb;
  v_cat_code        text;
  v_units_requested integer;
  v_bulk_requested  integer := 0;
  v_anc_requested   integer := 0;
  v_id_requested    integer := 0;
  v_bulk_available  integer;
  v_anc_available   integer;
  v_id_available    integer;
  v_terms           text;
  v_terms_version   int;
  v_unoffered       uuid;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.audit_actor', p_actor_id::text, true);
  END IF;

  -- Staged go-live gate (WS-A / VER-269): an inactive (held-back) or non-existent
  -- area returns no row, mirroring create_id_booking_with_capacity_check.
  SELECT capacity_pool_id INTO v_pool_id
  FROM collection_area
  WHERE id = p_collection_area_id AND is_active;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collection area % is not open for bookings', p_collection_area_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Eligibility gate: admin-retired parcels (is_eligible = false) must not
  -- accept bookings. A missing property row also fails closed.
  PERFORM 1 FROM eligible_properties
  WHERE id = p_property_id AND is_eligible;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property is not eligible for collection bookings'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Offered-service gate: every item must be a service this area offers (a
  -- service_rules row). Pricing reads a missing rule as 0 free units at a $0
  -- extra price, so an un-offered service (e.g. a Mattress in Town of
  -- Cambridge) would otherwise book for $0 from a hand-crafted request.
  SELECT (item->>'service_id')::uuid INTO v_unoffered
  FROM jsonb_array_elements(p_items) AS item
  WHERE NOT EXISTS (
    SELECT 1 FROM service_rules sr
    WHERE sr.collection_area_id = p_collection_area_id
      AND sr.service_id = (item->>'service_id')::uuid
  )
  LIMIT 1;

  IF v_unoffered IS NOT NULL THEN
    RAISE EXCEPTION 'Service % is not offered in this collection area', v_unoffered
      USING ERRCODE = 'check_violation';
  END IF;

  -- T&Cs gate: when the client has terms, acceptance is mandatory. Empty/whitespace
  -- terms => skipped (data-driven rollout). Text is read server-side and snapshotted;
  -- callers supply only the boolean + channel, never the text.
  SELECT terms_markdown, terms_version INTO v_terms, v_terms_version
  FROM public.client WHERE id = p_client_id;

  IF COALESCE(v_terms ~ '\S', false) AND NOT p_terms_accepted THEN
    RAISE EXCEPTION 'Terms and Conditions must be accepted before booking'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_pool_id IS NOT NULL THEN
    SELECT cd.date INTO v_date
    FROM collection_date cd
    WHERE cd.id = p_collection_date_id;

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
    FROM collection_date_pool
    WHERE id = v_pool_date_id;
  ELSE
    SELECT bulk_capacity_limit - bulk_units_booked,
           anc_capacity_limit  - anc_units_booked,
           id_capacity_limit   - id_units_booked
    INTO v_bulk_available, v_anc_available, v_id_available
    FROM collection_date
    WHERE id = p_collection_date_id;
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

  v_ref := generate_booking_ref(p_area_code);

  INSERT INTO booking (
    ref, status, type, property_id, contact_id, collection_area_id,
    client_id, contractor_id, fy_id, location, notes,
    terms_accepted_at, terms_accepted_text, terms_version,
    terms_accepted_by, terms_accepted_channel, created_via
  ) VALUES (
    v_ref, p_status::booking_status, p_type::booking_type,
    p_property_id, p_contact_id, p_collection_area_id,
    p_client_id, p_contractor_id, p_fy_id, p_location, p_notes,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN now()           ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN v_terms         ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN v_terms_version ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN p_actor_id      ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN p_terms_channel ELSE NULL END,
    p_created_via
  )
  RETURNING id INTO v_booking_id;

  INSERT INTO booking_item (
    booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra
  )
  SELECT
    v_booking_id,
    (item->>'service_id')::uuid,
    p_collection_date_id,
    (item->>'no_services')::integer,
    (item->>'unit_price_cents')::integer,
    (item->>'is_extra')::boolean
  FROM jsonb_array_elements(p_items) AS item;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'ref', v_ref
  );
END;
$function$;

-- ── 2. Admin MUD create (createMudBooking; staff-callable directly) ────────
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
  v_unoffered       uuid;
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

  -- Offered-service gate (mirrors create_booking_with_capacity_check): every
  -- item must be a service the MUD's area offers. createMudBooking builds its
  -- items from the area's rules, but any staff caller can reach this RPC
  -- directly.
  SELECT (item->>'service_id')::uuid INTO v_unoffered
  FROM jsonb_array_elements(p_items) AS item
  WHERE NOT EXISTS (
    SELECT 1 FROM service_rules sr
    WHERE sr.collection_area_id = v_area_id
      AND sr.service_id = (item->>'service_id')::uuid
  )
  LIMIT 1;

  IF v_unoffered IS NOT NULL THEN
    RAISE EXCEPTION 'Service % is not offered in this collection area', v_unoffered
      USING ERRCODE = 'check_violation';
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

-- ── 3. Edit in place (create-booking EF `replaces`, service_role only) ────
CREATE OR REPLACE FUNCTION public.update_booking_items_in_place(
  p_booking_id uuid,
  p_collection_date_id uuid,
  p_items jsonb,
  p_actor_id uuid DEFAULT NULL::uuid,
  p_location text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_expected_items jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_booking         booking%ROWTYPE;
  v_pool_id         uuid;
  v_date            date;
  v_pool_date_id    uuid;
  v_lock_key        bigint;
  v_existing_bulk   integer;
  v_existing_anc    integer;
  v_existing_id     integer;
  v_new_bulk        integer;
  v_new_anc         integer;
  v_new_id          integer;
  v_bulk_available  integer;
  v_anc_available   integer;
  v_id_available    integer;
  v_bulk_delta      integer;
  v_anc_delta       integer;
  v_id_delta        integer;
  v_unoffered       uuid;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.audit_actor', p_actor_id::text, true);
  END IF;

  SELECT * INTO v_booking FROM booking WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking not found: %', p_booking_id;
  END IF;

  SELECT capacity_pool_id INTO v_pool_id
  FROM collection_area WHERE id = v_booking.collection_area_id;

  IF v_pool_id IS NOT NULL THEN
    SELECT cd.date INTO v_date FROM collection_date cd WHERE cd.id = p_collection_date_id;
    SELECT id INTO v_pool_date_id FROM collection_date_pool
      WHERE capacity_pool_id = v_pool_id AND date = v_date;
    IF v_pool_date_id IS NULL THEN
      RAISE EXCEPTION 'No collection_date_pool row for pool % on date %', v_pool_id, v_date;
    END IF;
    v_lock_key := ('x' || substr(v_pool_date_id::text, 1, 8))::bit(32)::bigint;
  ELSE
    v_lock_key := ('x' || substr(p_collection_date_id::text, 1, 8))::bit(32)::bigint;
  END IF;

  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- #387.1 concurrency precondition. Verify the booking's CURRENT items (under
  -- the lock) still match the set the caller priced its refund against. A
  -- mismatch means a concurrent edit landed since the caller read its baseline,
  -- so its refund would be wrong — abort and let it re-price. Compared as
  -- service_id → summed no_services (order-independent); NULL skips the check.
  IF p_expected_items IS NOT NULL THEN
    -- Status re-check under the lock: the EF gates on Confirmed BEFORE this
    -- transaction, and a concurrent cancel changes status but not items, so the
    -- items comparison below would pass. Without this, an inline edit racing a
    -- cancel rewrites items on a Cancelled booking and raises a delta refund on
    -- top of the cancel's full-amount one. Message carries the EF's
    -- concurrent-edit marker so it maps to the retryable 409.
    IF v_booking.status <> 'Confirmed' THEN
      RAISE EXCEPTION 'Booking status changed since this edit was priced (concurrent edit) — reload and try again';
    END IF;

    IF EXISTS (
      WITH cur AS (
        SELECT service_id, SUM(no_services)::int AS qty
        FROM booking_item WHERE booking_id = p_booking_id
        GROUP BY service_id
      ),
      exp AS (
        SELECT (e->>'service_id')::uuid AS service_id, SUM((e->>'no_services')::int)::int AS qty
        FROM jsonb_array_elements(p_expected_items) AS e
        GROUP BY (e->>'service_id')::uuid
      )
      SELECT 1
      FROM cur FULL OUTER JOIN exp USING (service_id)
      WHERE COALESCE(cur.qty, 0) IS DISTINCT FROM COALESCE(exp.qty, 0)
    ) THEN
      RAISE EXCEPTION 'Booking items changed since this edit was priced (concurrent edit) — reload and try again';
    END IF;

    -- Date pin: a concurrent date change (updateCollectionDetails) moves
    -- booking_item.collection_date_id without changing quantities, so it passes
    -- the items comparison — but applying this edit would silently snap every
    -- item back to the stale date it was priced against (and shuffle capacity
    -- counters with it). Abort so the caller re-reads. Same marker message.
    IF EXISTS (
      SELECT 1 FROM booking_item
      WHERE booking_id = p_booking_id
        AND collection_date_id IS DISTINCT FROM p_collection_date_id
    ) THEN
      RAISE EXCEPTION 'Booking date changed since this edit was priced (concurrent edit) — reload and try again';
    END IF;
  END IF;

  CREATE TEMP TABLE _new_items (
    service_id        uuid    NOT NULL,
    no_services       integer NOT NULL,
    unit_price_cents  integer NOT NULL,
    is_extra          boolean NOT NULL,
    category_code     text    NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO _new_items (service_id, no_services, unit_price_cents, is_extra, category_code)
  SELECT
    (item->>'service_id')::uuid,
    (item->>'no_services')::integer,
    (item->>'unit_price_cents')::integer,
    (item->>'is_extra')::boolean,
    item->>'category_code'
  FROM jsonb_array_elements(p_items) AS item;

  -- Offered-service gate (see create_booking_with_capacity_check). An edit may
  -- keep or reduce a service already on the booking even if its rule has since
  -- been removed (a staff reduction that owes a refund must still go through),
  -- but may not add one or increase it: the extra units would price at $0.
  SELECT n.service_id INTO v_unoffered
  FROM (
    SELECT service_id, SUM(no_services) AS qty FROM _new_items GROUP BY service_id
  ) n
  WHERE NOT EXISTS (
      SELECT 1 FROM service_rules sr
      WHERE sr.collection_area_id = v_booking.collection_area_id
        AND sr.service_id = n.service_id
    )
    AND n.qty > COALESCE((
      SELECT SUM(bi.no_services) FROM booking_item bi
      WHERE bi.booking_id = p_booking_id AND bi.service_id = n.service_id
    ), 0)
  LIMIT 1;

  IF v_unoffered IS NOT NULL THEN
    RAISE EXCEPTION 'Service % is not offered in this collection area', v_unoffered
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN c.code = 'bulk' THEN bi.no_services END), 0),
    COALESCE(SUM(CASE WHEN c.code = 'anc'  THEN bi.no_services END), 0),
    COALESCE(SUM(CASE WHEN c.code = 'id'   THEN bi.no_services END), 0)
  INTO v_existing_bulk, v_existing_anc, v_existing_id
  FROM booking_item bi
  JOIN service s ON s.id = bi.service_id
  JOIN category c ON c.id = s.category_id
  WHERE bi.booking_id = p_booking_id;

  SELECT
    COALESCE(SUM(CASE WHEN category_code = 'bulk' THEN no_services END), 0),
    COALESCE(SUM(CASE WHEN category_code = 'anc'  THEN no_services END), 0),
    COALESCE(SUM(CASE WHEN category_code = 'id'   THEN no_services END), 0)
  INTO v_new_bulk, v_new_anc, v_new_id
  FROM _new_items;

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

  v_bulk_delta := v_new_bulk - v_existing_bulk;
  v_anc_delta  := v_new_anc  - v_existing_anc;
  v_id_delta   := v_new_id   - v_existing_id;

  IF v_bulk_delta > 0 AND v_bulk_delta > v_bulk_available THEN
    RAISE EXCEPTION 'Insufficient bulk capacity on collection date';
  END IF;
  IF v_anc_delta > 0 AND v_anc_delta > v_anc_available THEN
    RAISE EXCEPTION 'Insufficient ancillary capacity on collection date';
  END IF;
  IF v_id_delta > 0 AND v_id_delta > v_id_available THEN
    RAISE EXCEPTION 'Insufficient illegal dumping capacity on collection date';
  END IF;

  DELETE FROM booking_item bi
  WHERE bi.booking_id = p_booking_id
  AND NOT EXISTS (
    SELECT 1 FROM _new_items ni
    WHERE ni.service_id        = bi.service_id
    AND   ni.is_extra          = bi.is_extra
    AND   ni.unit_price_cents  = bi.unit_price_cents
  );

  UPDATE booking_item bi
  SET
    no_services        = ni.no_services,
    collection_date_id = p_collection_date_id
  FROM _new_items ni
  WHERE bi.booking_id        = p_booking_id
  AND   bi.service_id        = ni.service_id
  AND   bi.is_extra          = ni.is_extra
  AND   bi.unit_price_cents  = ni.unit_price_cents
  AND ( bi.no_services        IS DISTINCT FROM ni.no_services
     OR bi.collection_date_id IS DISTINCT FROM p_collection_date_id);

  INSERT INTO booking_item
    (booking_id, service_id, collection_date_id, no_services, unit_price_cents, is_extra)
  SELECT p_booking_id, ni.service_id, p_collection_date_id, ni.no_services, ni.unit_price_cents, ni.is_extra
  FROM _new_items ni
  WHERE NOT EXISTS (
    SELECT 1 FROM booking_item bi
    WHERE bi.booking_id        = p_booking_id
    AND   bi.service_id        = ni.service_id
    AND   bi.is_extra          = ni.is_extra
    AND   bi.unit_price_cents  = ni.unit_price_cents
  );

  IF (p_location IS NOT NULL AND p_location IS DISTINCT FROM v_booking.location)
     OR (p_notes IS NOT NULL AND p_notes IS DISTINCT FROM v_booking.notes) THEN
    UPDATE booking
       SET location = COALESCE(p_location, location),
           notes    = COALESCE(p_notes, notes)
     WHERE id = p_booking_id;
  END IF;

  RETURN jsonb_build_object('booking_id', p_booking_id, 'ref', v_booking.ref);
END;
$function$;
