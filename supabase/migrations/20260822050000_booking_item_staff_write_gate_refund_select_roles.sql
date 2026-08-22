-- Security batch (#383 + #387.c): DB-layer enforcement for two gaps that app
-- code alone was covering.
--
-- 1. #383 — booking_item staff write gate.
--    booking_item_staff_update (20260515055645) admits the four staff tiers
--    with NO column / status / date / area condition, so a client-tier JWT
--    could PATCH booking_item via PostgREST and bypass the contractor-tier gate
--    the app enforces in updateCollectionDetails (collection-details-edit.ts):
--      - set unit_price_cents / is_extra / service_id directly (Red Line #1)
--      - move an item onto a closed, past or full date (contractor-only in app)
--      - edit items on a Scheduled/Completed booking (contractor-only in app)
--      - repoint collection_date_id to ANOTHER AREA's / tenant's date — the
--        INSERT policy pins area, the UPDATE policy never did, and
--        recalculate_units then mutates that tenant's counters.
--    Same shape as enforce_booking_item_field_columns (20260803013000): a
--    BEFORE UPDATE trigger keyed on current_user_role(), NULL-safe so the
--    service role (create-booking EF, crons) and role-less callers skip it.
--    A trigger, not RLS: the rule needs OLD vs NEW + the parent booking's
--    status + the target date's is_open/date/area, which in a per-row RLS
--    USING clause is the §21 statement_timeout class.
--
--    Legitimate writers under a user JWT, all unaffected:
--      - updateCollectionDetails → UPDATE collection_date_id (already passes
--        every check below for the roles it allows)
--      - update_booking_items_in_place (SECURITY INVOKER) → UPDATE no_services
--        + collection_date_id only (same date in the in-place flow)
--      - bulk_update_booking_item_actuals → actual_services (field; own trigger)
--      - NCN/NP rebook → INSERT (INSERT policy pins area)
--
-- 2. #387.c — refund_request_staff_select admitted the field role.
--    The policy gated on is_client_staff() OR is_contractor_user() despite its
--    own "No field role" header — is_contractor_user() includes field (the
--    CLAUDE.md §4 trap). Field crews could SELECT refund amounts + the resident
--    contact FK via PostgREST. Recreated with the explicit four-role check the
--    UPDATE policy already uses; stable helpers hoisted to InitPlan.

-- ─── 1. booking_item staff write gate ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_booking_item_staff_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role          app_role := current_user_role();
  v_booking_status booking_status;
  v_booking_area  uuid;
  v_date_open     boolean;
  v_date          date;
  v_date_area     uuid;
  v_today         date := (now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
  -- Service role / role-less: not our concern (matches the field pin trigger).
  IF v_role IS NULL THEN
    RETURN NEW;
  END IF;

  -- (a) Identity + price columns are immutable under ANY user JWT. No app path
  --     changes these after insert; price is server-calculated (Red Line #1).
  IF NEW.booking_id       IS DISTINCT FROM OLD.booking_id
     OR NEW.service_id       IS DISTINCT FROM OLD.service_id
     OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
     OR NEW.is_extra         IS DISTINCT FROM OLD.is_extra THEN
    RAISE EXCEPTION 'booking_item identity and price columns cannot be changed';
  END IF;

  -- (b) Date moves: target must belong to the booking's own area — for every
  --     role (app: updateCollectionDetails area check; INSERT policy pins it).
  IF NEW.collection_date_id IS DISTINCT FROM OLD.collection_date_id THEN
    SELECT b.collection_area_id, b.status
      INTO v_booking_area, v_booking_status
      FROM booking b WHERE b.id = NEW.booking_id;
    SELECT cd.is_open, cd.date, cd.collection_area_id
      INTO v_date_open, v_date, v_date_area
      FROM collection_date cd WHERE cd.id = NEW.collection_date_id;

    IF v_date_area IS DISTINCT FROM v_booking_area THEN
      RAISE EXCEPTION 'Target collection date is not in this booking''s collection area';
    END IF;
  END IF;

  -- (c) Client-tier restrictions — mirrors canEditCollectionDetails +
  --     canRescheduleToTargetDate (collection-details-edit.ts).
  IF (v_role IN ('client-admin'::app_role, 'client-staff'::app_role)) IS TRUE THEN
    IF v_booking_status IS NULL THEN
      SELECT b.status INTO v_booking_status FROM booking b WHERE b.id = NEW.booking_id;
    END IF;

    IF v_booking_status NOT IN (
         'Pending Payment'::booking_status,
         'Submitted'::booking_status,
         'Confirmed'::booking_status
       ) THEN
      RAISE EXCEPTION 'Only contractor staff may edit items on a % booking', v_booking_status;
    END IF;

    IF NEW.collection_date_id IS DISTINCT FROM OLD.collection_date_id
       AND (COALESCE(v_date_open, false) = false OR v_date < v_today) THEN
      RAISE EXCEPTION 'Only contractor staff may move a booking onto a closed or past collection date';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_booking_item_staff_write() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS enforce_booking_item_staff_write ON public.booking_item;
CREATE TRIGGER enforce_booking_item_staff_write
  BEFORE UPDATE ON public.booking_item
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_item_staff_write();

-- ─── 2. refund_request SELECT: explicit staff roles, no field ───────────────

DROP POLICY IF EXISTS refund_request_staff_select ON public.refund_request;
CREATE POLICY refund_request_staff_select ON public.refund_request
  FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (SELECT current_user_role()) = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND user_sub_client_allows_booking(booking_id)
  );
