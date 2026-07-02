-- ============================================================================
-- Anon EXECUTE-grant pass on SECURITY DEFINER functions (pre-analytics, pt 2)
-- ============================================================================
-- Follows 20260702060000. Postgres grants EXECUTE to PUBLIC on function
-- creation, so every public-schema function is callable by anon via
-- PostgREST /rpc/ unless explicitly revoked FROM PUBLIC (revoking from anon
-- alone is a no-op while the PUBLIC grant remains).
--
-- Three buckets:
--
-- 1. Privileged staff RPCs → revoke PUBLIC + anon, keep authenticated +
--    service_role (their explicit grants already exist). All are internally
--    staff/tenant-gated except retry_notification_log, which gains the
--    NULL-safe gate below. client_has_terms / collection_area_is_active are
--    only referenced by booking INSERT policies — inserting roles are always
--    authenticated (guest flow OTPs first), so anon never evaluates them.
--
-- 2. Trigger-only functions → revoke PUBLIC + anon + authenticated. Postgres
--    checks EXECUTE on trigger functions at CREATE TRIGGER time (as the
--    trigger creator), never at fire time, so triggers keep firing for all
--    roles' DML (verified empirically against prod in a rolled-back txn).
--
-- 3. KEPT for anon (deliberate — do not "fix" these): the identity/tenancy
--    helpers (current_user_*, is_*, has_role, accessible_client_ids,
--    user_sub_client_*, current_user_client_allows_property) and
--    resolve_booking_redirect. The helpers are referenced by RLS policies on
--    tables the unauthenticated /book flow queries (eligible_properties,
--    collection_date, allocation_rules, service_rules, client, …) and
--    function EXECUTE is permission-checked against the QUERYING role when a
--    policy references it — revoking anon breaks the public flow with 42501.
--    They are inert for anon anyway: all key on auth.uid(), which is NULL →
--    NULL/false/empty. resolve_booking_redirect is called by the proxy /b/<ref>
--    path with the anon key by design.
--
-- Functions are resolved by name from pg_proc (drift-tolerant, matches
-- 20260702060000). Idempotent — REVOKE of an absent grant is a no-op.
-- No row data is touched.
-- ============================================================================

DO $$
DECLARE
  fn regprocedure;
BEGIN
  -- Bucket 1: staff RPCs — anon out, authenticated/service_role stay
  FOR fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'assignable_ticket_staff', 'get_rect_sla', 'resolve_actor_names',
      'retry_notification_log', 'upsert_strata_contact_and_link',
      'client_has_terms', 'collection_area_is_active'
    )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
  END LOOP;

  -- Bucket 2: trigger-only — no role needs runtime EXECUTE
  FOR fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'audit_trigger_fn', 'assign_resident_role_on_signup',
      'revert_allocation_swap_on_cancel', 'stamp_first_response',
      'sync_stops_on_booking_status'
    )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END $$;

-- retry_notification_log had NO internal role gate: as SECURITY DEFINER its
-- UPDATE bypasses notification_log RLS, so before this migration ANY caller
-- (incl. anon) with a log uuid could re-queue a failed notification and
-- trigger a real resend. Sole caller is the admin server action (user JWT,
-- app-gated to staff) — this adds the DB-level gate per CLAUDE.md §21
-- NULL-safe pattern. CREATE OR REPLACE resets proconfig, so the search_path
-- pin from 20260702060000 must be (and is) re-declared here. Grants/ACL are
-- preserved by CREATE OR REPLACE, so the bucket-1 revoke above still holds.
CREATE OR REPLACE FUNCTION public.retry_notification_log(log_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status text;
BEGIN
  -- Staff only. IS NOT TRUE: current_user_role() is NULL for a caller with no
  -- active user_roles row, and NULL IN (...) is NULL → a bare NOT IN would
  -- silently pass role-less callers (CLAUDE.md §21).
  IF (current_user_role() IN (
    'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only staff roles can retry notifications';
  END IF;

  SELECT status INTO v_status
  FROM notification_log
  WHERE id = log_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notification log row not found: %', log_id;
  END IF;

  IF v_status <> 'failed' THEN
    RAISE EXCEPTION 'Row is not in failed status (current: %)', v_status;
  END IF;

  UPDATE notification_log
  SET status = 'queued', error_message = NULL
  WHERE id = log_id;

  RETURN log_id;
END;
$fn$;

-- Hygiene: the view is read-only by design (and not auto-updatable anyway) —
-- drop the default write grants Supabase issued at creation. SELECT stays.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.v_mud_next_expected FROM anon, authenticated;
