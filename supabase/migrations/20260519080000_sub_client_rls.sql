-- VER-216 — Sub-client scoping at the RLS layer
--
-- Step 1 added `user_roles.sub_client_id`. This migration wires it into the
-- RLS policies on the staff-readable, security-relevant tables. The 12
-- existing signed-in users have sub_client_id = NULL, which the helpers
-- below treat as "full client scope" — behaviour unchanged for them.
--
-- Linear: VER-216
--
-- ============================================================================
-- DESIGN NOTES
-- ============================================================================
--
-- 1) Helpers follow the existing SECURITY DEFINER pattern (see initial_schema
--    around line 890). Each is small, STABLE, and reads user_roles directly
--    to avoid recursive RLS — same pattern as current_user_role(),
--    current_user_client_id(), etc.
--
-- 2) Predicate helpers return TRUE when the user has no sub-client scope
--    (sub_client_id IS NULL). That makes every policy a strict superset of
--    its previous behaviour: an unscoped user sees exactly what they saw
--    before; a scoped user sees a subset.
--
-- 3) Only staff-readable, sub-client-scope-meaningful tables are modified:
--    booking, non_conformance_notice, nothing_presented, service_ticket,
--    eligible_properties (UPDATE only), collection_area (UPDATE/DELETE only),
--    allocation_rules (UPDATE/DELETE only), service_rules (UPDATE/DELETE
--    only).
--
--    Tables NOT modified and why:
--    - booking_item: SELECT/UPDATE policies route through booking via IN
--      (SELECT id FROM booking), so they inherit booking's sub-client scope
--      transitively. No change needed.
--    - eligible_properties / collection_area / collection_date /
--      allocation_rules / service_rules SELECT: each has a parallel
--      *_public_select policy with USING(true) for the unauthenticated
--      /book flow. Multiple SELECT policies combine with OR — adding
--      sub-client scope to *_select wouldn't block reads via *_public_select.
--      App-layer scoping for staff UIs is the right place; documenting that
--      decision here.
--    - allocation_override: currently scopes by role only, not by
--      client_id. That's a pre-existing security gap (any client-admin can
--      see all allocation_overrides), separate from this work. Flagged for
--      a follow-up ticket.
--    - resident / contractor / field policies: out of scope. Resident and
--      strata are end-users with their own contact-scoped policies.
--      Contractor-tier sees everything by design. Field has contractor_id
--      not client_id, so the CHECK constraint added in step 1 enforces
--      sub_client_id IS NULL — the predicate helpers return TRUE for them.
--
-- 4) Naming convention: predicate helpers return TRUE when the row is
--    allowed by the user's sub-client scope (i.e. they're a positive check),
--    so policies AND them on top of existing predicates without flipping
--    semantics.


-- ============================================================================
-- HELPERS
-- ============================================================================

CREATE OR REPLACE FUNCTION current_user_sub_client_id()
RETURNS uuid AS $$
  SELECT sub_client_id FROM user_roles
   WHERE user_id = auth.uid() AND is_active = true
   LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION current_user_sub_client_id() IS
  'Returns the calling user''s sub_client_id from user_roles, or NULL when '
  'they have no sub-client scope. NULL means "full client scope" — see '
  'VER-216.';

-- Predicate: does the user's sub-client scope allow this collection_area?
-- TRUE if the user is unscoped (sub_client_id IS NULL) OR the area's
-- sub_client_id matches the user's.
CREATE OR REPLACE FUNCTION user_sub_client_allows_area(area_id uuid)
RETURNS boolean AS $$
  SELECT
    current_user_sub_client_id() IS NULL
    OR EXISTS (
      SELECT 1 FROM collection_area
       WHERE id = area_id
         AND sub_client_id = current_user_sub_client_id()
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION user_sub_client_allows_area(uuid) IS
  'TRUE when the calling user''s sub-client scope allows reading/writing rows '
  'tied to this collection_area. Returns TRUE for users with NULL '
  'sub_client_id (no scoping). See VER-216.';

-- Predicate: does the user's sub-client scope allow this booking?
-- Joins booking → collection_area to read sub_client_id.
CREATE OR REPLACE FUNCTION user_sub_client_allows_booking(booking_id_in uuid)
RETURNS boolean AS $$
  SELECT
    current_user_sub_client_id() IS NULL
    OR EXISTS (
      SELECT 1
        FROM booking b
        JOIN collection_area ca ON ca.id = b.collection_area_id
       WHERE b.id = booking_id_in
         AND ca.sub_client_id = current_user_sub_client_id()
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION user_sub_client_allows_booking(uuid) IS
  'TRUE when the calling user''s sub-client scope allows reading/writing rows '
  'tied to this booking. Resolves booking → collection_area → sub_client_id. '
  'See VER-216.';


-- ============================================================================
-- BOOKING — client-tier staff + ranger
-- ============================================================================

DROP POLICY IF EXISTS booking_client_staff_select ON booking;
CREATE POLICY booking_client_staff_select ON booking FOR SELECT
  USING (
    client_id = current_user_client_id()
    AND is_client_staff()
    AND user_sub_client_allows_area(collection_area_id)
  );

DROP POLICY IF EXISTS booking_field_select ON booking;
CREATE POLICY booking_field_select ON booking FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND is_field_user()
    AND user_sub_client_allows_area(collection_area_id)
  );

DROP POLICY IF EXISTS booking_staff_update ON booking;
CREATE POLICY booking_staff_update ON booking FOR UPDATE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (is_client_staff() OR is_contractor_user())
    AND user_sub_client_allows_area(collection_area_id)
  );

DROP POLICY IF EXISTS booking_field_update ON booking;
CREATE POLICY booking_field_update ON booking FOR UPDATE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND has_role('field'::app_role)
    AND status = 'Scheduled'::booking_status
    AND user_sub_client_allows_area(collection_area_id)
  )
  WITH CHECK (
    status = ANY (ARRAY[
      'Completed'::booking_status,
      'Non-conformance'::booking_status,
      'Nothing Presented'::booking_status
    ])
  );


-- ============================================================================
-- NON-CONFORMANCE NOTICE
-- ============================================================================

DROP POLICY IF EXISTS ncn_staff_select ON non_conformance_notice;
CREATE POLICY ncn_staff_select ON non_conformance_notice FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (is_client_staff() OR is_contractor_user() OR is_field_user())
    AND user_sub_client_allows_booking(booking_id)
  );

DROP POLICY IF EXISTS ncn_staff_update ON non_conformance_notice;
CREATE POLICY ncn_staff_update ON non_conformance_notice FOR UPDATE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND user_sub_client_allows_booking(booking_id)
  );


-- ============================================================================
-- NOTHING PRESENTED
-- ============================================================================

DROP POLICY IF EXISTS np_staff_select ON nothing_presented;
CREATE POLICY np_staff_select ON nothing_presented FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (is_client_staff() OR is_contractor_user() OR is_field_user())
    AND user_sub_client_allows_booking(booking_id)
  );

DROP POLICY IF EXISTS np_staff_update ON nothing_presented;
CREATE POLICY np_staff_update ON nothing_presented FOR UPDATE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND user_sub_client_allows_booking(booking_id)
  );


-- ============================================================================
-- SERVICE TICKET
-- ============================================================================
--
-- Tickets may not always be tied to a booking (booking_id is nullable on
-- service_ticket). For un-tied tickets we fall back to the existing
-- client-level scope only — sub-client scope can't restrict what it can't
-- see. A scoped ranger seeing client-level-only tickets is acceptable:
-- those tickets are operational rather than per-property.

DROP POLICY IF EXISTS service_ticket_staff_select ON service_ticket;
CREATE POLICY service_ticket_staff_select ON service_ticket FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (is_client_staff() OR current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role
    ]))
    AND (booking_id IS NULL OR user_sub_client_allows_booking(booking_id))
  );

DROP POLICY IF EXISTS service_ticket_staff_update ON service_ticket;
CREATE POLICY service_ticket_staff_update ON service_ticket FOR UPDATE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (is_client_staff() OR current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role
    ]))
    AND (booking_id IS NULL OR user_sub_client_allows_booking(booking_id))
  );


-- ============================================================================
-- ELIGIBLE PROPERTIES — staff UPDATE only
-- ============================================================================
--
-- SELECT is intentionally not scoped here: eligible_properties_public_select
-- (USING true) is needed for the unauthenticated /book flow and combines
-- with this policy via OR.

DROP POLICY IF EXISTS eligible_properties_staff_update ON eligible_properties;
CREATE POLICY eligible_properties_staff_update ON eligible_properties FOR UPDATE
  USING (
    current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND collection_area_id IN (
      SELECT id FROM collection_area
       WHERE client_id IN (SELECT accessible_client_ids())
    )
    AND user_sub_client_allows_area(collection_area_id)
  );


-- ============================================================================
-- COLLECTION AREA — client-admin UPDATE/DELETE only
-- ============================================================================
--
-- Same reasoning as eligible_properties: collection_area_public_select makes
-- SELECT cross-tenant by design.

DROP POLICY IF EXISTS collection_area_client_admin_update ON collection_area;
CREATE POLICY collection_area_client_admin_update ON collection_area FOR UPDATE
  USING (
    has_role('client-admin'::app_role)
    AND client_id = current_user_client_id()
    AND user_sub_client_allows_area(id)
  );

DROP POLICY IF EXISTS collection_area_client_admin_delete ON collection_area;
CREATE POLICY collection_area_client_admin_delete ON collection_area FOR DELETE
  USING (
    has_role('client-admin'::app_role)
    AND client_id = current_user_client_id()
    AND user_sub_client_allows_area(id)
  );


-- ============================================================================
-- ALLOCATION RULES — admin UPDATE/DELETE only
-- ============================================================================

DROP POLICY IF EXISTS allocation_rules_admin_update ON allocation_rules;
CREATE POLICY allocation_rules_admin_update ON allocation_rules FOR UPDATE
  USING (
    current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND collection_area_id IN (
      SELECT id FROM collection_area
       WHERE client_id IN (SELECT accessible_client_ids())
    )
    AND user_sub_client_allows_area(collection_area_id)
  );

DROP POLICY IF EXISTS allocation_rules_admin_delete ON allocation_rules;
CREATE POLICY allocation_rules_admin_delete ON allocation_rules FOR DELETE
  USING (
    current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND collection_area_id IN (
      SELECT id FROM collection_area
       WHERE client_id IN (SELECT accessible_client_ids())
    )
    AND user_sub_client_allows_area(collection_area_id)
  );


-- ============================================================================
-- SERVICE RULES — admin UPDATE/DELETE only
-- ============================================================================

DROP POLICY IF EXISTS service_rules_admin_update ON service_rules;
CREATE POLICY service_rules_admin_update ON service_rules FOR UPDATE
  USING (
    current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND collection_area_id IN (
      SELECT id FROM collection_area
       WHERE client_id IN (SELECT accessible_client_ids())
    )
    AND user_sub_client_allows_area(collection_area_id)
  );

DROP POLICY IF EXISTS service_rules_admin_delete ON service_rules;
CREATE POLICY service_rules_admin_delete ON service_rules FOR DELETE
  USING (
    current_user_role() = ANY (ARRAY[
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    ])
    AND collection_area_id IN (
      SELECT id FROM collection_area
       WHERE client_id IN (SELECT accessible_client_ids())
    )
    AND user_sub_client_allows_area(collection_area_id)
  );
