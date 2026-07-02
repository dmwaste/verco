-- ============================================================================
-- Tenant-scope the last two role-only SECURITY DEFINER RPCs + finish the
-- search_path/anon sweep (pre-analytics hardening, pt 3 — follows 060000/080000)
-- ============================================================================
-- 080000 closed the anon EXECUTE hole and gave retry_notification_log a
-- NULL-safe *role* gate. A pre-landing review found two RPCs are role-gated
-- but NOT tenant-gated: as SECURITY DEFINER they bypass their tables' RLS, so
-- a staff user of council A holding a council-B row uuid can act on B's data.
-- Exploitability is low (uuids are unguessable and the caller must be authed
-- staff of some tenant), but this is a multi-tenant government product and
-- these are the last two cross-tenant paths, so we close them before the
-- analytics embed ships.
--
-- 1. retry_notification_log — a client-A staffer with a council-B log uuid
--    could flip B's failed notification back to 'queued' (silent audit-trail
--    corruption) AND trigger a real cross-tenant resend (the send path is
--    role-gated end-to-end). notification_log.client_id is NOT NULL (verified
--    prod: 224 rows, 0 null), so gate the write to accessible_client_ids().
--
-- 2. resolve_actor_names — resolves auth.uid → display name (PII) for the
--    audit timeline. Role-only, arbitrary uuid[] input. Scope it to actors
--    who appear as audit_log.changed_by within the caller's accessible
--    clients. That EXACTLY mirrors audit_log's own RLS SELECT scope
--    (client_id IN accessible_client_ids), so it never rejects a legitimate
--    resolution — the resolver only ever passes changed_by ids taken from
--    audit rows the caller could already read (src/lib/audit/resolve.ts) —
--    while blocking arbitrary cross-tenant name probing.
--
-- 3. get_property_penetration — the one RPC of interest that slipped both
--    prior sweeps: still anon-EXECUTEable and pinned `search_path = public`
--    without pg_temp (the §21 rule 060000 introduced). It is SECURITY INVOKER
--    and tenant-guarded internally (anon gets (0,0)), so this is hygiene, but
--    it re-trips the advisor pattern and undercuts the "0 remaining" state.
--    Its only caller is the admin SLA dashboard (authenticated).
--
-- CREATE OR REPLACE preserves each function's ACL, so the anon revokes from
-- 080000 stand. Both re-declares re-assert the search_path pin (CREATE OR
-- REPLACE resets proconfig). Idempotent; no row data touched.
-- ============================================================================

-- 1. retry_notification_log — role gate (unchanged) + tenant guard
CREATE OR REPLACE FUNCTION public.retry_notification_log(log_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_status    text;
  v_client_id uuid;
BEGIN
  -- Staff only. IS NOT TRUE: current_user_role() is NULL for a caller with no
  -- active user_roles row, and NULL IN (...) is NULL → a bare NOT IN would
  -- silently pass role-less callers (CLAUDE.md §21).
  IF (current_user_role() IN (
    'contractor-admin','contractor-staff','client-admin','client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only staff roles can retry notifications';
  END IF;

  SELECT status, client_id INTO v_status, v_client_id
  FROM notification_log
  WHERE id = log_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Notification log row not found: %', log_id;
  END IF;

  -- Tenant guard (SECURITY DEFINER bypasses notification_log RLS). client_id
  -- is NOT NULL, so IS NOT TRUE only fires for a genuinely out-of-scope row.
  IF (v_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RAISE EXCEPTION 'Notification is outside your accessible clients';
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

-- 2. resolve_actor_names — role gate (unchanged) + tenant guard via audit_log
CREATE OR REPLACE FUNCTION public.resolve_actor_names(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT p.id, COALESCE(p.display_name, c.full_name)
  FROM profiles p
  LEFT JOIN contacts c ON c.id = p.contact_id
  WHERE p.id = ANY(p_user_ids)
    AND COALESCE(p.display_name, c.full_name) IS NOT NULL
    -- Staff-only gate. NULL-safe: current_user_role() is NULL for a caller with
    -- no active role, and NULL IN (...) is NULL → row excluded (fails closed).
    AND (current_user_role() IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    ))
    -- Tenant guard: only resolve actors who acted on an audit row within the
    -- caller's accessible clients. Mirrors audit_log's RLS SELECT scope, so it
    -- never rejects a legitimate timeline resolution (the resolver only passes
    -- changed_by ids read from audit rows the caller could already see) while
    -- blocking arbitrary cross-tenant name probing. Bounded by p_user_ids for
    -- an index-friendly semi-join; SECURITY DEFINER means this explicit
    -- client_id filter IS the scope (it bypasses audit_log RLS).
    AND p.id IN (
      SELECT al.changed_by
      FROM audit_log al
      WHERE al.changed_by = ANY(p_user_ids)
        AND al.client_id IN (SELECT accessible_client_ids())
    );
$fn$;

-- 3. get_property_penetration — finish the §21 sweep it missed
ALTER FUNCTION public.get_property_penetration(uuid, uuid) SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.get_property_penetration(uuid, uuid) FROM PUBLIC, anon;
