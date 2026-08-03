-- booking_item: field crews could not save MUD actual-collected counts (#494).
--
-- The only UPDATE policy (booking_item_staff_update, 20260515055645) admits
-- the four staff tiers — not `field`. The crew MUD counts flow
-- (stop-mud-form → saveMudActualServices → bulk_update_booking_item_actuals,
-- SECURITY INVOKER) therefore updated 0 rows with no error: the RPC returns
-- void with no row-count assertion, the action returned ok, and the counts
-- form re-rendered empty — the exact silent-fail class that migration's own
-- header documents, one table over.
--
-- Three parts, deliberately in one migration (CLAUDE.md §21: a new write
-- path and its RLS land together):
--   1. Column-pin trigger: with an UPDATE policy in place, a field JWT could
--      PATCH any granted column via PostgREST — including unit_price_cents
--      (Red Line #1). Field writers may change actual_services ONLY; every
--      other column is pinned. jsonb-diff form so a future column is pinned
--      by default instead of silently becoming field-editable.
--   2. booking_item_field_update policy: has_role('field') (ranger excluded,
--      matching collection_stop_field_update), parent booking must be
--      Scheduled, tenant + sub-client scope cascades through booking's own
--      RLS via the correlated EXISTS (booking_item has no client_id column;
--      per-PK-row updates keep the subquery cheap — this is the same shape
--      booking_item_staff_update already uses).
--   3. bulk_update_booking_item_actuals asserts ROW_COUNT: an RLS-filtered
--      update now raises instead of returning silent success, so this class
--      can never present as "saved" again.

-- 1. Column pin for field writers. current_user_role() is NULL for the
--    service role and role-less callers — the pin then skips, which is safe:
--    role-less users pass no UPDATE policy at all, and EF/service-role writes
--    are deliberately unrestricted here (same stance as
--    enforce_stop_state_transition's privileged bypass).
CREATE OR REPLACE FUNCTION public.enforce_booking_item_field_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (current_user_role() = 'field'::app_role) IS TRUE THEN
    IF to_jsonb(NEW) - 'actual_services' - 'updated_at'
       IS DISTINCT FROM to_jsonb(OLD) - 'actual_services' - 'updated_at' THEN
      RAISE EXCEPTION 'Field crews may only change actual_services on a booking item';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_booking_item_field_columns ON public.booking_item;
CREATE TRIGGER enforce_booking_item_field_columns
  BEFORE UPDATE ON public.booking_item
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_item_field_columns();

-- 2. Field UPDATE policy. USING gates the existing row (parent booking must
--    be Scheduled — counts are entered while the crew works the stop, frozen
--    once the booking goes terminal); WITH CHECK re-runs the same gate on the
--    NEW row so booking_id cannot be repointed out of scope (the pin trigger
--    blocks that too — defence in depth). has_role wrapped in (SELECT …) per
--    the initplan guidance; the EXISTS is correlated per-row by design.
DROP POLICY IF EXISTS booking_item_field_update ON public.booking_item;
CREATE POLICY booking_item_field_update ON public.booking_item
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT has_role('field'::app_role))
    AND EXISTS (
      SELECT 1 FROM booking b
       WHERE b.id = booking_item.booking_id
         AND b.status = 'Scheduled'::booking_status
    )
  )
  WITH CHECK (
    (SELECT has_role('field'::app_role))
    AND EXISTS (
      SELECT 1 FROM booking b
       WHERE b.id = booking_item.booking_id
         AND b.status = 'Scheduled'::booking_status
    )
  );

-- 3. Row-count assertion in the bulk RPC. Body otherwise unchanged from
--    20260516020000.
CREATE OR REPLACE FUNCTION public.bulk_update_booking_item_actuals(
  p_booking_id uuid,
  p_updates jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_supplied_count integer;
  v_matched_count integer;
  v_updated_count integer;
BEGIN
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RAISE EXCEPTION 'p_updates must be a JSON array';
  END IF;

  SELECT count(*) INTO v_supplied_count
  FROM jsonb_array_elements(p_updates);

  IF v_supplied_count = 0 THEN
    RAISE EXCEPTION 'No updates supplied';
  END IF;

  -- Ownership + existence check: every supplied id must resolve to a
  -- booking_item that belongs to p_booking_id AND that the caller's RLS
  -- allows them to read.
  SELECT count(*) INTO v_matched_count
  FROM jsonb_to_recordset(p_updates) AS u(id uuid, actual_count integer)
  JOIN booking_item bi ON bi.id = u.id
  WHERE bi.booking_id = p_booking_id;

  IF v_matched_count <> v_supplied_count THEN
    RAISE EXCEPTION
      'Ownership check failed: % of % booking_item ids matched booking %',
      v_matched_count, v_supplied_count, p_booking_id;
  END IF;

  -- Reject negative actual counts at the SQL boundary too.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_updates) AS u(id uuid, actual_count integer)
    WHERE u.actual_count IS NULL OR u.actual_count < 0
  ) THEN
    RAISE EXCEPTION 'Each actual_count must be a non-negative integer';
  END IF;

  -- Bulk UPDATE. RLS UPDATE policy on booking_item gates the write — and the
  -- row count is asserted, because an RLS-filtered UPDATE affects 0 rows
  -- WITHOUT error. Before this assertion a role with SELECT but no UPDATE
  -- (field, until this migration) got silent success and lost the counts
  -- (#494). The message surfaces verbatim in the crew UI — keep it human.
  UPDATE booking_item bi
  SET actual_services = u.actual_count
  FROM jsonb_to_recordset(p_updates) AS u(id uuid, actual_count integer)
  WHERE bi.id = u.id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> v_supplied_count THEN
    RAISE EXCEPTION
      'Counts were not saved (% of % updated) — your role may not have permission for this booking. Tell your supervisor.',
      v_updated_count, v_supplied_count;
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bulk_update_booking_item_actuals(uuid, jsonb) TO authenticated;
