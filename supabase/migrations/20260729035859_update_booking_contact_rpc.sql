-- BR-0031 (#452): admin edit of a booking's resident contact details silently
-- rejected — `contacts` has RLS enabled with SELECT-only policies and no write
-- policy for any role, so the booking-detail updateContact() action's direct
-- .update() matches zero rows ("Contact update was not applied").
--
-- Fix mirrors the strata precedent (20260611055522, BR-0016/VER-255): a
-- SECURITY DEFINER RPC rather than a bare UPDATE policy — the strata
-- migration's header documents why plain write policies were rejected for
-- this table (chicken-and-egg SELECT visibility; unlinked silent no-ops;
-- invisible PII rows). The RPC anchors on the BOOKING, not a caller-supplied
-- contact id: the caller can only ever touch the contact of a booking their
-- tenant scope can access. Consumer (updateContact in
-- app/(admin)/admin/bookings/[id]/actions.ts) lands in the follow-up PR after
-- types regen (§18 split).

CREATE OR REPLACE FUNCTION public.update_booking_contact(
  p_booking_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_mobile_e164 text  -- NULL clears the stored number (matches the action)
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contact_id uuid;
  v_client_id  uuid;
BEGIN
  -- Staff only. IS NOT TRUE: current_user_role() is NULL for a caller with
  -- no active user_roles row, and NULL IN (...) is NULL → a bare NOT IN
  -- would silently pass role-less callers (CLAUDE.md §21).
  IF (current_user_role() IN (
    'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only staff roles can update booking contacts';
  END IF;

  -- Defence in depth — zod validates upstream in the server action.
  IF coalesce(btrim(p_first_name), '') = '' OR coalesce(btrim(p_last_name), '') = '' THEN
    RAISE EXCEPTION 'First and last name are required';
  END IF;
  IF coalesce(btrim(p_email), '') = '' THEN
    RAISE EXCEPTION 'Email is required';
  END IF;

  -- Tenant anchor: the booking whose contact is being corrected.
  SELECT b.contact_id, b.client_id
  INTO v_contact_id, v_client_id
  FROM booking b
  WHERE b.id = p_booking_id;

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;
  IF v_contact_id IS NULL THEN
    RAISE EXCEPTION 'Booking has no linked contact';
  END IF;

  IF v_client_id NOT IN (SELECT accessible_client_ids()) THEN
    RAISE EXCEPTION 'Booking is outside your accessible clients';
  END IF;

  -- Sub-client narrowing (VER-216). NULL narrowing passes.
  IF NOT user_sub_client_allows_booking(p_booking_id) THEN
    RAISE EXCEPTION 'Booking is outside your sub-client scope';
  END IF;

  -- full_name is GENERATED ALWAYS — write first/last only. The contacts
  -- audit trigger records the caller via auth.uid(), which survives
  -- SECURITY DEFINER, so the audit trail shows the real staff actor.
  UPDATE contacts
  SET first_name  = btrim(p_first_name),
      last_name   = btrim(p_last_name),
      email       = lower(btrim(p_email)),
      mobile_e164 = nullif(btrim(coalesce(p_mobile_e164, '')), '')
  WHERE id = v_contact_id;

  RETURN v_contact_id;
END;
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default — close it in the same
-- migration (§21), then grant the roles that may call it.
REVOKE EXECUTE ON FUNCTION public.update_booking_contact(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_booking_contact(uuid, text, text, text, text) TO authenticated, service_role;
