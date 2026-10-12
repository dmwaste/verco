-- Contact edits can no longer spread to other people's bookings (WMRC, 12/10/2026).
--
-- Contacts are found by email, and an email is not always one person: staff took
-- phone bookings under the WMRC office address, so one contact row ended up on
-- 278 residents' bookings at 272 addresses. On 05/10 a staff member corrected
-- the contact on ONE booking via update_booking_contact, which edits the row in
-- place, and all 278 bookings switched to a strata company's email and mobile.
--
-- Both staff-facing contact writes now apply the same rule as create-booking
-- (_shared/contact-match.ts): a row may only be rewritten when the change can't
-- reach anyone else.
--
--   update_booking_contact — if the booking's contact is also used by a booking
--   at another address, or is a MUD strata contact, the edit goes to a NEW
--   contact row and only this booking is repointed. A contact used only at this
--   address (same household) is still corrected in place.
--
--   upsert_strata_contact_and_link — an existing row with the same name + mobile
--   is linked untouched; otherwise the oldest row with the email is updated only
--   if no resident (non-MUD) booking uses it — a strata manager's own correction
--   still reaches all their MUDs; anything else gets a NEW row.
--
-- Signatures and return types are unchanged (no types regen). CREATE OR REPLACE
-- keeps the existing grants; search_path is re-declared (§21).

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
  v_contact_id  uuid;
  v_client_id   uuid;
  v_property_id uuid;
  v_new_id      uuid;
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
  SELECT b.contact_id, b.client_id, b.property_id
  INTO v_contact_id, v_client_id, v_property_id
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

  -- Shared beyond this address? Then the edit belongs to this booking alone.
  IF EXISTS (
       SELECT 1 FROM booking b
       WHERE b.contact_id = v_contact_id
         AND b.id <> p_booking_id
         AND b.property_id IS DISTINCT FROM v_property_id
     )
     OR EXISTS (SELECT 1 FROM eligible_properties ep WHERE ep.strata_contact_id = v_contact_id)
  THEN
    -- full_name is GENERATED ALWAYS — write first/last only.
    INSERT INTO contacts (first_name, last_name, email, mobile_e164)
    VALUES (
      btrim(p_first_name),
      btrim(p_last_name),
      lower(btrim(p_email)),
      nullif(btrim(coalesce(p_mobile_e164, '')), '')
    )
    RETURNING id INTO v_new_id;

    UPDATE booking SET contact_id = v_new_id WHERE id = p_booking_id;
    RETURN v_new_id;
  END IF;

  -- The contacts audit trigger records the caller via auth.uid(), which
  -- survives SECURITY DEFINER, so the audit trail shows the real staff actor.
  UPDATE contacts
  SET first_name  = btrim(p_first_name),
      last_name   = btrim(p_last_name),
      email       = lower(btrim(p_email)),
      mobile_e164 = nullif(btrim(coalesce(p_mobile_e164, '')), '')
  WHERE id = v_contact_id;

  RETURN v_contact_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_strata_contact_and_link(
  p_property_id uuid,
  p_first_name text,
  p_last_name text,
  p_mobile_e164 text,
  p_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_area_id       uuid;
  v_client_id     uuid;
  v_contractor_id uuid;
  v_contact_id    uuid;
BEGIN
  -- Staff only. IS NOT TRUE: current_user_role() is NULL for a caller with
  -- no active user_roles row, and NULL IN (...) is NULL → a bare NOT IN
  -- would silently pass role-less callers (CLAUDE.md §21).
  IF (current_user_role() IN (
    'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'Only staff roles can manage strata contacts';
  END IF;

  -- Defence in depth — zod validates upstream.
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'Email is required';
  END IF;
  IF coalesce(btrim(p_first_name), '') = '' OR coalesce(btrim(p_last_name), '') = '' THEN
    RAISE EXCEPTION 'First and last name are required';
  END IF;
  IF coalesce(btrim(p_mobile_e164), '') = '' THEN
    RAISE EXCEPTION 'Mobile number is required';
  END IF;

  -- Tenant anchor: the property being linked.
  SELECT ca.id, ca.client_id, ca.contractor_id
  INTO v_area_id, v_client_id, v_contractor_id
  FROM eligible_properties ep
  JOIN collection_area ca ON ca.id = ep.collection_area_id
  WHERE ep.id = p_property_id;

  IF v_area_id IS NULL THEN
    RAISE EXCEPTION 'Property not found';
  END IF;

  IF v_client_id NOT IN (SELECT accessible_client_ids()) THEN
    RAISE EXCEPTION 'Property is outside your accessible clients';
  END IF;

  -- Sub-client narrowing (VER-216). NULL narrowing passes.
  IF NOT user_sub_client_allows_area(v_area_id) THEN
    RAISE EXCEPTION 'Property is outside your sub-client scope';
  END IF;

  -- Same person already on file (email + name + mobile) → link it untouched.
  -- Case-insensitive; oldest row wins when duplicates exist (VER-256).
  SELECT c.id INTO v_contact_id
  FROM contacts c
  WHERE lower(c.email) = lower(btrim(p_email))
    AND lower(btrim(c.first_name)) = lower(btrim(p_first_name))
    AND lower(btrim(c.last_name)) = lower(btrim(p_last_name))
    AND coalesce(c.mobile_e164, '') = btrim(p_mobile_e164)
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_contact_id IS NULL THEN
    -- A row no resident booking uses is a strata manager's own record — their
    -- correction may reach all their MUDs. A row residents' bookings use is
    -- never rewritten from here.
    SELECT c.id INTO v_contact_id
    FROM contacts c
    WHERE lower(c.email) = lower(btrim(p_email))
      AND NOT EXISTS (
        SELECT 1 FROM booking b
        JOIN eligible_properties ep ON ep.id = b.property_id
        WHERE b.contact_id = c.id AND NOT coalesce(ep.is_mud, false)
      )
    ORDER BY c.created_at ASC
    LIMIT 1;

    IF v_contact_id IS NULL THEN
      -- full_name is GENERATED ALWAYS — write first/last only.
      INSERT INTO contacts (first_name, last_name, mobile_e164, email)
      VALUES (btrim(p_first_name), btrim(p_last_name), btrim(p_mobile_e164), btrim(p_email))
      RETURNING id INTO v_contact_id;
    ELSE
      UPDATE contacts
      SET first_name  = btrim(p_first_name),
          last_name   = btrim(p_last_name),
          mobile_e164 = btrim(p_mobile_e164)
      WHERE id = v_contact_id;
    END IF;
  END IF;

  -- Link atomically with the upsert — no orphan window: if anything above
  -- raised, the whole transaction rolls back; once we reach here the contact
  -- is linked and therefore visible via contacts_admin_strata_select.
  UPDATE eligible_properties
  SET strata_contact_id = v_contact_id
  WHERE id = p_property_id;

  RETURN jsonb_build_object('contact_id', v_contact_id);
END;
$$;
