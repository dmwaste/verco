-- ============================================================================
-- Service ticket detail: expose the ticket's contact to staff + scope the
-- "Assign to" list to eligible, tenant-correct staff.
-- ============================================================================
-- Two gaps on /admin/service-tickets/[id]:
--
-- 1. CONTACT CARD BLANK. service_ticket.contact_id was plumbed without a
--    matching `contacts` SELECT policy. The existing contacts staff policies
--    expose a contact only via a BOOKING or a STRATA property — so a contact
--    linked ONLY through a ticket (e.g. a Booking Enquiry from someone with no
--    booking under this client) is invisible to staff, and the Resident card
--    renders empty. Classic rls-coverage-lags-data-plumbing. Fix: a contacts
--    SELECT policy via the service_ticket path, tenant-scoped, staff-only
--    (field/ranger never match → PII rule intact).
--
-- 2. "ASSIGN TO" SHOWS ALL STAFF, ALL CLIENTS. The page queried user_roles
--    with no client scope. It can't be fixed with a plain scoped query either:
--    user_roles_staff_select only lets a client-tier viewer see user_roles for
--    their OWN client_id, so a KWN client-admin literally cannot enumerate D&M
--    contractor staff to assign them. Fix: a SECURITY DEFINER RPC that returns
--    the eligible assignees — contractor staff for the ticket's contractor +
--    client staff for the ticket's client — gated so only a staff caller with
--    access to the ticket's client gets results.

-- ── 1. contacts SELECT via service_ticket ────────────────────────────────
CREATE POLICY contacts_ticket_staff_select ON contacts FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM service_ticket st
    JOIN client cl ON cl.id = st.client_id
    WHERE st.contact_id = contacts.id
      AND (
        (current_user_role() IN ('contractor-admin', 'contractor-staff')
          AND (cl.contractor_id = current_user_contractor_id()
               OR st.client_id IN (SELECT accessible_client_ids())))
        OR (current_user_role() IN ('client-admin', 'client-staff')
          AND st.client_id = current_user_client_id())
      )
  )
);

-- ── 2. assignable staff resolver ─────────────────────────────────────────
-- Returns contractor-tier staff for the ticket's contractor + client-tier
-- staff for the ticket's client. SECURITY DEFINER so a client-tier caller can
-- see contractor staff (user_roles RLS would otherwise hide them). Name via
-- coalesce(display_name, contacts.full_name) — same as resolve_actor_names, so
-- staff with a NULL display_name still render a real name (not a UUID stub).
CREATE OR REPLACE FUNCTION public.assignable_ticket_staff(p_ticket_id uuid)
RETURNS TABLE (user_id uuid, name text, role app_role)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
DECLARE
  v_client_id     uuid;
  v_contractor_id uuid;
BEGIN
  -- Staff-only. NULL-safe (no active role → NULL IN (...) → not true → return).
  IF (current_user_role() IN (
    'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RETURN;
  END IF;

  SELECT st.client_id, cl.contractor_id
  INTO v_client_id, v_contractor_id
  FROM service_ticket st
  JOIN client cl ON cl.id = st.client_id
  WHERE st.id = p_ticket_id;

  IF v_client_id IS NULL THEN
    RETURN;  -- ticket not found / no client
  END IF;

  -- Caller must have access to the ticket's client (tenant guardrail).
  IF NOT (
    (current_user_role() IN ('contractor-admin', 'contractor-staff')
      AND (v_contractor_id = current_user_contractor_id()
           OR v_client_id IN (SELECT accessible_client_ids())))
    OR (current_user_role() IN ('client-admin', 'client-staff')
      AND v_client_id = current_user_client_id())
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT p.id, COALESCE(p.display_name, c.full_name), ur.role
  FROM user_roles ur
  JOIN profiles p ON p.id = ur.user_id
  LEFT JOIN contacts c ON c.id = p.contact_id
  WHERE ur.is_active
    AND (
      (ur.role IN ('contractor-admin', 'contractor-staff')
        AND ur.contractor_id = v_contractor_id)
      OR (ur.role IN ('client-admin', 'client-staff')
        AND ur.client_id = v_client_id)
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.assignable_ticket_staff(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assignable_ticket_staff(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.assignable_ticket_staff(uuid) IS
  'Eligible "Assign to" staff for a service ticket: contractor-tier staff for the ticket''s contractor + client-tier staff for the ticket''s client. SECURITY DEFINER so client-tier callers can see contractor staff (user_roles RLS hides them); self-gated to a staff caller with access to the ticket''s client. Consumed by /admin/service-tickets/[id].';
