-- ============================================================================
-- Survey public-access fix (PR-A). See plan we-need-to-flesh-snappy-crayon.md.
--
-- The public /survey/[token] page runs as the ANON role (residents are logged
-- out). booking_survey RLS has only field_insert + resident_select (contact-
-- gated) + staff_select — NO anon SELECT and NO UPDATE policy. So for a real
-- logged-out resident the page's SELECT returns 0 rows (link 404s) and the
-- submit UPDATE silently affects 0 rows (feedback lost). The 20260326053510
-- comment promised "Token-based public access handled in API route" but that
-- layer was never built. Build it here as two SECURITY DEFINER RPCs.
--
-- The unguessable 128-bit token is the capability. The functions never accept a
-- client_id and never expose cross-token data or prior responses, so anon
-- EXECUTE (the default PUBLIC grant) is safe and REQUIRED — do not revoke.
-- ============================================================================

-- 1. Public read: resolve a survey's submitted-state + booking display fields by
--    token, entirely inside the definer (removes all anon RLS dependence on
--    booking_survey / booking / booking_item).
CREATE OR REPLACE FUNCTION public.get_survey_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_survey    booking_survey%ROWTYPE;
  v_ref       text;
  v_coll_date date;
  v_chips     jsonb;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_survey FROM booking_survey WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;                       -- page -> notFound()
  END IF;

  SELECT b.ref INTO v_ref FROM booking b WHERE b.id = v_survey.booking_id;

  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object('name', s.name, 'qty', bi.no_services, 'isExtra', bi.is_extra)
        ORDER BY bi.is_extra, s.name
      ),
      '[]'::jsonb
    ),
    min(cd.date)
  INTO v_chips, v_coll_date
  FROM booking_item bi
  JOIN service s          ON s.id  = bi.service_id
  JOIN collection_date cd ON cd.id = bi.collection_date_id
  WHERE bi.booking_id = v_survey.booking_id;

  RETURN jsonb_build_object(
    'submitted',       v_survey.submitted_at IS NOT NULL,
    'booking_ref',     COALESCE(v_ref, ''),
    'collection_date', v_coll_date,      -- date or null
    'service_chips',   COALESCE(v_chips, '[]'::jsonb)
  );
END;
$fn$;

COMMENT ON FUNCTION public.get_survey_by_token(text) IS
  'anon EXECUTE intentional — token-gated public survey read; SECURITY DEFINER, search_path pinned. Returns NULL for unknown token; never returns prior responses. Do NOT revoke anon.';

-- 2. Public write: submit responses once, idempotently. FOR UPDATE serialises
--    concurrent submits; structural guards only (rich shape validation lives in
--    the server action against the code-owned SURVEY_QUESTIONS set).
CREATE OR REPLACE FUNCTION public.submit_survey_by_token(p_token text, p_responses jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_id           uuid;
  v_submitted_at timestamptz;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Token is required.');
  END IF;
  IF p_responses IS NULL
     OR jsonb_typeof(p_responses) <> 'object'
     OR pg_column_size(p_responses) > 20000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid responses.');
  END IF;

  SELECT id, submitted_at INTO v_id, v_submitted_at
  FROM booking_survey
  WHERE token = p_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Survey not found.');
  END IF;
  IF v_submitted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This survey has already been submitted.');
  END IF;

  UPDATE booking_survey
  SET responses = p_responses, submitted_at = now()
  WHERE id = v_id;

  RETURN jsonb_build_object('ok', true);
END;
$fn$;

COMMENT ON FUNCTION public.submit_survey_by_token(text, jsonb) IS
  'anon EXECUTE intentional — token-gated public survey submit; SECURITY DEFINER, search_path pinned, FOR UPDATE for single-submission. Do NOT revoke anon.';

-- 3. Staff DELETE policy on booking_survey (spam / privacy-request removal).
--    Mirrors booking_survey_staff_select exactly (client-tier staff + contractor
--    admin/staff, tenant-scoped, sub-client narrowed). NULL-safe: current_user_role()
--    is NULL for anon -> (NULL = ANY(...)) / is_client_staff() false -> denied.
CREATE POLICY booking_survey_staff_delete ON public.booking_survey
  FOR DELETE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (
      is_client_staff()
      OR current_user_role() = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role])
    )
    AND user_sub_client_allows_booking(booking_id)
  );

-- 4. Audit trail on booking_survey. audit_trigger_fn() derives client_id from the
--    direct client_id column (booking_survey has one), so no function change.
DROP TRIGGER IF EXISTS audit_trigger ON public.booking_survey;
CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.booking_survey
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
