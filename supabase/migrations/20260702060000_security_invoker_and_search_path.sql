-- ============================================================================
-- Security hardening ahead of council-facing embedded analytics
-- ============================================================================
-- 1. v_mud_next_expected → security_invoker = on
--    Views default to DEFINER semantics: they execute as the view owner
--    (postgres), which bypasses the querying user's RLS. This view aggregates
--    booking/booking_item across ALL tenants and anon holds a SELECT grant on
--    it, so any caller could read cross-tenant booking-derived dates (Supabase
--    advisor `security_definer_view` ERROR). With security_invoker = on the
--    underlying tables' RLS applies to the caller. The two admin consumers
--    (dashboard MUD widget + property detail page) query it with staff JWTs
--    that already see their own tenant's bookings, so their output is
--    unchanged; eligible_properties rows remain visible (public-SELECT by
--    design, tenant-scoped in app code via getTenantMudPropertyIds) but
--    last_date/next_expected_date now derive only from bookings the caller
--    is allowed to see.
--
--    ANY NEW VIEW must be created WITH (security_invoker = on) — especially
--    anything feeding council-facing analytics.
--
-- 2. Pin search_path on every function flagged `function_search_path_mutable`
--    (20 SECURITY DEFINER role/tenancy helpers + 11 trigger/RPC functions),
--    plus the 10 SECURITY DEFINER helpers already pinned to `public` — those
--    are upgraded to `public, pg_temp`. When pg_temp is not listed explicitly
--    it is searched FIRST for relations, so a session could shadow
--    public.user_roles etc. with a temp table and subvert the role helpers;
--    listing pg_temp LAST closes that. No function body references
--    extension-schema objects (verified against prod 2026-07-02), so
--    `public, pg_temp` is sufficient.
--
--    Functions are resolved by name from pg_proc rather than hardcoded
--    signatures so the migration still applies cleanly if a signature
--    changes (or a function is dropped) before this reaches main.
--
-- Both operations are idempotent — safe to re-apply. No row data is touched.
-- ============================================================================

ALTER VIEW public.v_mud_next_expected SET (security_invoker = on);

DO $$
DECLARE
  fn regprocedure;
  pinned int := 0;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        -- SECURITY DEFINER role/tenancy helpers (previously unpinned)
        'accessible_client_ids', 'assign_resident_role_on_signup', 'audit_trigger_fn',
        'client_has_terms', 'collection_area_is_active', 'current_user_client_allows_property',
        'current_user_client_id', 'current_user_contact_id', 'current_user_contact_id_by_email',
        'current_user_contractor_id', 'current_user_role', 'current_user_sub_client_id',
        'has_role', 'is_client_staff', 'is_contractor_user', 'is_field_user', 'is_staff_role',
        'retry_notification_log', 'user_sub_client_allows_area', 'user_sub_client_allows_booking',
        -- SECURITY INVOKER trigger/RPC functions flagged by the advisor
        'bulk_update_booking_item_actuals', 'close_imminent_collection_dates',
        'create_booking_with_capacity_check', 'enforce_booking_state_transition',
        'enforce_cancellation_cutoff', 'enforce_stop_state_transition', 'generate_booking_ref',
        'handle_updated_at', 'recalculate_collection_date_units', 'rollup_booking_status_from_stops',
        'update_booking_items_in_place',
        -- SECURITY DEFINER helpers already pinned to `public` — add pg_temp
        'assignable_ticket_staff', 'create_id_booking_with_capacity_check',
        'create_mud_booking_with_capacity_check', 'get_rect_sla', 'resolve_actor_names',
        'resolve_booking_redirect', 'revert_allocation_swap_on_cancel', 'stamp_first_response',
        'sync_stops_on_booking_status', 'upsert_strata_contact_and_link'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn);
    pinned := pinned + 1;
  END LOOP;
  RAISE NOTICE 'search_path pinned on % functions', pinned;
END $$;
