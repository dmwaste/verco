-- T&Cs acceptance gate. Per-client Terms & Conditions, enforced + recorded on the
-- booking. See docs/superpowers/specs/2026-06-23-tcs-acceptance-design.md.
--
-- PR-A (this migration): schema + client_has_terms() helper + booking_resident_insert
-- RLS bypass closure + create_booking_with_capacity_check re-declared with the gate.
-- PR-B (separate, after this is in prod): EF/action/UI consumers + regen'd types.

-- ── 1. Per-client terms content + version ──────────────────────────────────
ALTER TABLE public.client
  ADD COLUMN IF NOT EXISTS terms_markdown text,
  ADD COLUMN IF NOT EXISTS terms_version  int NOT NULL DEFAULT 1;

-- ── 2. Acceptance record on the booking (all nullable — empty terms => skipped) ──
ALTER TABLE public.booking
  ADD COLUMN IF NOT EXISTS terms_accepted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS terms_accepted_text    text,
  ADD COLUMN IF NOT EXISTS terms_version          int,
  ADD COLUMN IF NOT EXISTS terms_accepted_by      uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS terms_accepted_channel text
    CHECK (terms_accepted_channel IS NULL
           OR terms_accepted_channel IN ('resident_self','staff_on_behalf','mud_admin'));

-- ── 3. Canonical "has terms" predicate ─────────────────────────────────────
-- SECURITY DEFINER + fail-closed so RLS can call it without recursing through the
-- client table's own policies. Mirrors collection_area_is_active (WS-A).
CREATE OR REPLACE FUNCTION public.client_has_terms(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  -- `~ '\S'` (has any non-whitespace char) is the exact SQL equivalent of the TS
  -- `(md ?? '').trim().length > 0` — matches across spaces/tabs/newlines. (btrim()
  -- trims only spaces, so it would wrongly treat a tabs/newlines-only value as terms.)
  SELECT COALESCE(
    (SELECT terms_markdown ~ '\S' FROM public.client WHERE id = p_client_id),
    false
  );
$$;

-- ── 4. Close the direct-INSERT RLS bypass ──────────────────────────────────
-- A resident/strata session can INSERT a booking directly via PostgREST, skipping
-- the RPC and therefore terms enforcement + recording. Mirror the WS-A is_active
-- closure: when the client has terms, require an acceptance record on the row.
-- The RPC path (which sets terms_accepted_at) still passes. Appends one term to the
-- existing policy (20260622090000) — no existing condition dropped.
DROP POLICY IF EXISTS booking_resident_insert ON public.booking;
CREATE POLICY booking_resident_insert ON public.booking FOR INSERT
  WITH CHECK (
    current_user_role() IN ('resident', 'strata')
    AND contact_id = current_user_contact_id()
    AND public.collection_area_is_active(collection_area_id)
    AND (NOT public.client_has_terms(client_id) OR terms_accepted_at IS NOT NULL)
  );

-- ── 5. Re-declare the capacity RPC with the terms gate + recording ─────────
-- Body copied verbatim from 20260622090000 with four deltas:
--   (a) two new DEFAULTed params p_terms_accepted / p_terms_channel,
--   (b) v_terms / v_terms_version locals,
--   (c) the terms gate (RAISE when client has terms and not accepted),
--   (d) the booking INSERT records text/version/acceptor/channel (only when terms exist).
-- The signature gains params, so DROP the old 14-arg function first to avoid an overload.
DROP FUNCTION IF EXISTS public.create_booking_with_capacity_check(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, uuid, text
);

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
  p_actor_id uuid DEFAULT NULL,
  p_type text DEFAULT 'Residential',
  p_terms_accepted boolean DEFAULT false,
  p_terms_channel text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
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
    terms_accepted_by, terms_accepted_channel
  ) VALUES (
    v_ref, p_status::booking_status, p_type::booking_type,
    p_property_id, p_contact_id, p_collection_area_id,
    p_client_id, p_contractor_id, p_fy_id, p_location, p_notes,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN now()           ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN v_terms         ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN v_terms_version ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN p_actor_id      ELSE NULL END,
    CASE WHEN COALESCE(v_terms ~ '\S', false) THEN p_terms_channel ELSE NULL END
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
