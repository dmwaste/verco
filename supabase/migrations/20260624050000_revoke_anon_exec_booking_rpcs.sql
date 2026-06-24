-- ============================================================================
-- VER-282 PR-B: tighten EXECUTE on the staff booking RPCs
-- ============================================================================
-- PR-A's `REVOKE … FROM PUBLIC` on create_mud_booking_with_capacity_check was
-- ineffective: Supabase default-grants EXECUTE to `anon` DIRECTLY, so the grant
-- survived. And the two RPCs got their anon access via DIFFERENT paths (verified
-- empirically against prod): create_mud via a direct `anon` grant, create_id via
-- a `PUBLIC` grant. So revoke BOTH `anon` and `PUBLIC`, then re-grant the roles
-- that actually call them — `authenticated` (the staff caller: createMudBooking
-- + illegal-dumping intake) and `service_role` (EF/internal).
--
-- Both RPCs self-enforce a staff/ranger role gate internally (anon hits a
-- role-gate RAISE), so this is defence-in-depth, not a functional change.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.create_mud_booking_with_capacity_check(uuid, uuid, jsonb, text, boolean) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_mud_booking_with_capacity_check(uuid, uuid, jsonb, text, boolean) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.create_id_booking_with_capacity_check(uuid, uuid, numeric, numeric, text, text, text[], text[], text) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_id_booking_with_capacity_check(uuid, uuid, numeric, numeric, text, text, text[], text[], text) TO authenticated, service_role;
