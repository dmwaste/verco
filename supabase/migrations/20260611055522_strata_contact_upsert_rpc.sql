-- VER-255: strata contact save fails on the MUD detail page (BR-0016).
--
-- contacts has RLS enabled with SELECT-only policies — no INSERT/UPDATE
-- policies exist, so upsertStrataContact()'s direct .insert()/.update() are
-- blocked. Plain write policies were reviewed and rejected (eng review D7):
--   * INSERT…RETURNING would still fail — a brand-new contact matches no
--     SELECT policy until eligible_properties.strata_contact_id links it
--     (RLS chicken-and-egg, VER-210 class);
--   * an unlinked-update would silently no-op for a booking-linked contact
--     (the "resident becomes strata manager" case would dead-end);
--   * failed saves would accumulate invisible, undeletable PII rows.
--
-- Instead: one SECURITY DEFINER RPC that looks up by email, inserts or
-- updates the contact, and LINKS it to the property atomically. Tenant +
-- sub-client scope are enforced via the property's collection_area — the
-- caller can only ever touch a contact in the act of binding it to a
-- property they administer.
CREATE OR REPLACE FUNCTION upsert_strata_contact_and_link(
  p_property_id uuid,
  p_first_name text,
  p_last_name text,
  p_mobile_e164 text,
  p_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Case-insensitive email match; oldest row wins deterministically when
  -- duplicates exist (no unique index on contacts.email — VER-256).
  SELECT id INTO v_contact_id
  FROM contacts
  WHERE lower(email) = lower(btrim(p_email))
  ORDER BY created_at ASC
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

  -- Link atomically with the upsert — no orphan window: if anything above
  -- raised, the whole transaction rolls back; once we reach here the contact
  -- is linked and therefore visible via contacts_admin_strata_select.
  UPDATE eligible_properties
  SET strata_contact_id = v_contact_id
  WHERE id = p_property_id;

  RETURN jsonb_build_object('contact_id', v_contact_id);
END;
$$;
