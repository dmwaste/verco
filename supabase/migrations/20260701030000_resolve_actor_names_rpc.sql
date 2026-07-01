-- ============================================================================
-- Audit actor resolution: SECURITY DEFINER name resolver
-- ============================================================================
-- The audit_actor_passthrough migration (20260515053849) fixed *capture* —
-- audit_log.changed_by is now correctly stamped with the acting user (e.g. the
-- resident who submitted a booking, via the create-booking EF's p_actor_id).
--
-- What remained broken is *resolution*. The admin activity timeline resolves
-- changed_by → a display name by reading `profiles` then stitching
-- `contacts.full_name` (resolveActorNames in src/lib/audit/resolve.ts). That
-- runs under the *viewer's* RLS. For a RESIDENT actor the profiles row is
-- hidden from staff by profiles_staff_select (deliberate — staff must not be
-- able to enumerate the full resident list), so the resolver gets nothing and
-- the timeline falls back to "System" — even though the admin already sees that
-- same resident's name in the Contact card on the same page (contacts is
-- readable for their tenant's bookings). RLS-correct, UX-wrong.
--
-- Fix (CLAUDE.md §12 — cross-table lookups RLS blocks → wrap in SECURITY
-- DEFINER): a definer resolver that maps user_id → coalesce(display_name,
-- contacts.full_name), bypassing profiles RLS. Hard-gated to STAFF roles so
-- field / ranger / resident callers (and null-role callers) get NOTHING — the
-- absolute PII rule (CLAUDE.md §4/§20) is preserved. Admin surfaces that
-- consume this are staff-only anyway; the names revealed are those of actors on
-- audit rows the caller can already read (audit_log is tenant-scoped by
-- accessible_client_ids()).

CREATE OR REPLACE FUNCTION public.resolve_actor_names(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  SELECT p.id, COALESCE(p.display_name, c.full_name)
  FROM profiles p
  LEFT JOIN contacts c ON c.id = p.contact_id
  WHERE p.id = ANY(p_user_ids)
    AND COALESCE(p.display_name, c.full_name) IS NOT NULL
    -- Staff-only gate. NULL-safe: current_user_role() is NULL for a caller with
    -- no active role, and NULL IN (...) is NULL → row excluded (fails closed).
    AND (current_user_role() IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    ));
$function$;

-- Audit resolution is admin-only. No anon EXECUTE; the authenticated staff
-- caller (server actions) + service_role only. The staff-role gate inside the
-- function is the real access control — this just trims needless surface.
REVOKE EXECUTE ON FUNCTION public.resolve_actor_names(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_actor_names(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_actor_names(uuid[]) IS
  'Audit timeline actor resolver. SECURITY DEFINER so staff can resolve a resident actor''s name (profiles is hidden from staff by RLS) → coalesce(display_name, contacts.full_name). Staff-role gated (field/ranger/resident/null-role get nothing) to preserve the PII rule. Consumed by resolveActorNames in src/lib/audit/resolve.ts.';
