-- Property notes & documents (ADR 0031).
--
-- Staff keep notes and signed permission-to-enter forms against an eligible
-- property. Visible to D&M staff and the owning council's staff only — never
-- field, ranger, resident, strata or anon.
--
-- Why a child table and not columns on eligible_properties: that table is
-- public-SELECT (`eligible_properties_public_select`) and /book reads it with
-- `select('*')` under the anon key, so any column added there is public.
--
-- Shape:
--   1. property_note table + client_id derivation trigger + removal-only
--      immutability trigger + audit trigger
--   2. RLS: staff role + tenant (denormalised client_id) + ADR 0019 sub-client
--      predicate; no DELETE policy (an indemnity record is never deleted
--      from the app — "Remove" stamps removed_at)
--   3. private `property-documents` bucket. Object path:
--        <client_id>/<property_id>/<uuid>-<file name>
--      INSERT gated on the path's client + property; SELECT inherits
--      property_note's RLS via EXISTS, so files and rows can't drift apart.
--      No UPDATE/DELETE policies — stored files are immutable.

-- ── 1. Table ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.property_note (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES public.eligible_properties(id),
  -- Derived from property → collection_area → client by trigger; caller
  -- input is overwritten. Indexed RLS gate + read by audit_trigger_fn.
  client_id    uuid NOT NULL REFERENCES public.client(id),
  kind         text NOT NULL DEFAULT 'note'
                 CHECK (kind IN ('access_form', 'note')),
  body         text CHECK (char_length(body) BETWEEN 1 AND 2000),
  file_path    text UNIQUE,
  file_name    text CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_type    text,
  file_size    integer CHECK (file_size > 0 AND file_size <= 10485760),
  created_by   uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  removed_by   uuid REFERENCES auth.users(id),

  CONSTRAINT property_note_has_content
    CHECK (body IS NOT NULL OR file_path IS NOT NULL),
  CONSTRAINT property_note_access_form_has_file
    CHECK (kind <> 'access_form' OR file_path IS NOT NULL),
  CONSTRAINT property_note_file_fields_together
    CHECK ((file_path IS NULL) = (file_name IS NULL)
       AND (file_path IS NULL) = (file_type IS NULL)
       AND (file_path IS NULL) = (file_size IS NULL))
);

COMMENT ON TABLE public.property_note IS
  'Staff notes and documents (e.g. permission-to-enter forms) on an eligible '
  'property. Staff-only, tenant + sub-client scoped. Rows are never deleted '
  'from the app; removal stamps removed_at. ADR 0031.';

CREATE INDEX IF NOT EXISTS idx_property_note_property_active
  ON public.property_note (property_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_property_note_client
  ON public.property_note (client_id);

-- client_id derivation. DEFINER so the derivation is the same whoever calls;
-- RLS WITH CHECK (applied after BEFORE triggers) decides whether the caller
-- may write it.
CREATE OR REPLACE FUNCTION public.property_note_set_client_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT ca.client_id INTO NEW.client_id
    FROM eligible_properties ep
    JOIN collection_area ca ON ca.id = ep.collection_area_id
   WHERE ep.id = NEW.property_id;

  IF NEW.client_id IS NULL THEN
    RAISE EXCEPTION 'property_note: property % not found', NEW.property_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS property_note_set_client_id ON public.property_note;
CREATE TRIGGER property_note_set_client_id
  BEFORE INSERT ON public.property_note
  FOR EACH ROW EXECUTE FUNCTION public.property_note_set_client_id();

-- Removal-only updates. The one permitted change is removed_at NULL → set;
-- the trigger stamps the time and the actor. Anything else raises — fix an
-- entry by removing it and adding a new one (ADR 0031).
CREATE OR REPLACE FUNCTION public.property_note_enforce_removal_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'property_note: entry % is already removed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.removed_at IS NULL
     OR (NEW.id, NEW.property_id, NEW.client_id, NEW.kind, NEW.body,
         NEW.file_path, NEW.file_name, NEW.file_type, NEW.file_size,
         NEW.created_by, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.property_id, OLD.client_id, OLD.kind, OLD.body,
         OLD.file_path, OLD.file_name, OLD.file_type, OLD.file_size,
         OLD.created_by, OLD.created_at)
  THEN
    RAISE EXCEPTION 'property_note: entries cannot be edited, only removed'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.removed_at := now();
  NEW.removed_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS property_note_enforce_removal_only ON public.property_note;
CREATE TRIGGER property_note_enforce_removal_only
  BEFORE UPDATE ON public.property_note
  FOR EACH ROW EXECUTE FUNCTION public.property_note_enforce_removal_only();

-- audit_trigger_fn() reads the direct client_id column, so no function change.
DROP TRIGGER IF EXISTS audit_trigger ON public.property_note;
CREATE TRIGGER audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.property_note
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

-- ── 2. RLS ───────────────────────────────────────────────────────────────

ALTER TABLE public.property_note ENABLE ROW LEVEL SECURITY;

-- Staff gate shared by every policy: staff role, own tenant, and (for
-- council-scoped staff) own sub-client. Helpers are (select …)-wrapped so
-- they hoist to InitPlans. The sub-client clause is a correlated pk-lookup
-- EXISTS, not the ADR 0019 / #616 set shape: this table is small and every
-- app read filters to one property, so building the whole sub-client
-- property set per query cost more (measured on prod, rolled back:
-- ~12.5 ms set vs ~6 ms EXISTS for a COT-scoped property read).
DROP POLICY IF EXISTS property_note_staff_select ON public.property_note;
CREATE POLICY property_note_staff_select ON public.property_note
  FOR SELECT TO authenticated
  USING (
    (SELECT current_user_role()) IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    )
    AND client_id IN (SELECT accessible_client_ids())
    AND (
      (SELECT current_user_sub_client_id()) IS NULL
      OR EXISTS (
        SELECT 1 FROM eligible_properties ep
          JOIN collection_area ca ON ca.id = ep.collection_area_id
         WHERE ep.id = property_note.property_id
           AND ca.sub_client_id = (SELECT current_user_sub_client_id())
      )
    )
  );

DROP POLICY IF EXISTS property_note_staff_insert ON public.property_note;
CREATE POLICY property_note_staff_insert ON public.property_note
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND removed_at IS NULL
    AND (SELECT current_user_role()) IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    )
    AND client_id IN (SELECT accessible_client_ids())
    AND (
      (SELECT current_user_sub_client_id()) IS NULL
      OR EXISTS (
        SELECT 1 FROM eligible_properties ep
          JOIN collection_area ca ON ca.id = ep.collection_area_id
         WHERE ep.id = property_note.property_id
           AND ca.sub_client_id = (SELECT current_user_sub_client_id())
      )
    )
  );

-- UPDATE exists only to stamp removed_at; the removal-only trigger pins
-- every other column.
DROP POLICY IF EXISTS property_note_staff_update ON public.property_note;
CREATE POLICY property_note_staff_update ON public.property_note
  FOR UPDATE TO authenticated
  USING (
    (SELECT current_user_role()) IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    )
    AND client_id IN (SELECT accessible_client_ids())
    AND (
      (SELECT current_user_sub_client_id()) IS NULL
      OR EXISTS (
        SELECT 1 FROM eligible_properties ep
          JOIN collection_area ca ON ca.id = ep.collection_area_id
         WHERE ep.id = property_note.property_id
           AND ca.sub_client_id = (SELECT current_user_sub_client_id())
      )
    )
  )
  WITH CHECK (
    (SELECT current_user_role()) IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    )
    AND client_id IN (SELECT accessible_client_ids())
    AND (
      (SELECT current_user_sub_client_id()) IS NULL
      OR EXISTS (
        SELECT 1 FROM eligible_properties ep
          JOIN collection_area ca ON ca.id = ep.collection_area_id
         WHERE ep.id = property_note.property_id
           AND ca.sub_client_id = (SELECT current_user_sub_client_id())
      )
    )
  );

-- No DELETE policy: rows are never deleted from the app (ADR 0031).

-- ── 3. Storage bucket ────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'property-documents',
  'property-documents',
  false,
  10485760,  -- 10 MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Upload gate: the object path must be <client_id>/<property_id>/<file>,
-- where the caller is staff, the client is theirs, and the property sits in
-- that client (and in their sub-client when they are council-scoped).
-- INVOKER: every lookup runs under the caller's own RLS too.
CREATE OR REPLACE FUNCTION public.can_upload_property_document(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parts    text[] := storage.foldername(p_name);
  v_client   uuid;
  v_property uuid;
BEGIN
  IF coalesce(array_length(v_parts, 1), 0) <> 2 THEN
    RETURN false;
  END IF;

  BEGIN
    v_client   := v_parts[1]::uuid;
    v_property := v_parts[2]::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  RETURN coalesce(
    current_user_role() IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    )
    AND v_client IN (SELECT accessible_client_ids())
    AND EXISTS (
      SELECT 1
        FROM eligible_properties ep
        JOIN collection_area ca ON ca.id = ep.collection_area_id
       WHERE ep.id = v_property
         AND ca.client_id = v_client
         AND (
           current_user_sub_client_id() IS NULL
           OR ca.sub_client_id = current_user_sub_client_id()
         )
    ),
    false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.can_upload_property_document(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_upload_property_document(text) TO authenticated;

DROP POLICY IF EXISTS property_documents_staff_insert ON storage.objects;
CREATE POLICY property_documents_staff_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'property-documents'
    AND public.can_upload_property_document(name)
  );

-- Read gate: a file is readable when its property_note row is —
-- property_note's own RLS (staff + tenant + sub-client) runs inside the
-- EXISTS as the caller. The second branch lets the uploader see their own
-- not-yet-attached object while they still hold upload rights to its path:
-- Storage's upload permission check is an INSERT … RETURNING, which must
-- also pass this SELECT policy before the property_note row exists.
DROP POLICY IF EXISTS property_documents_staff_read ON storage.objects;
CREATE POLICY property_documents_staff_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'property-documents'
    AND (
      EXISTS (
        SELECT 1 FROM public.property_note pn
         WHERE pn.file_path = objects.name
      )
      OR (
        owner_id = (SELECT auth.uid())::text
        AND public.can_upload_property_document(name)
      )
    )
  );

-- No UPDATE / DELETE policies: stored documents are immutable.
