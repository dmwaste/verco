-- Shared evidence-photo bucket for NCN/NP notices and Illegal Dumping bookings.
-- Both the NCN form (field closeout) and the ID booking form (ranger) upload
-- here and persist the resulting getPublicUrl() value, so the bucket is PUBLIC
-- (read via unguessable UUID paths). Writes are gated by role via RLS below.
--
-- Path conventions (app-enforced):
--   ncn:  <booking_id>/<uuid>.<ext>
--   id:   id-bookings/<uuid>.<ext>
--
-- Until now this bucket was referenced by code but never created, so every
-- upload silently failed — blocking both ID submissions and NCN evidence.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ncn-photos',
  'ncn-photos',
  true,
  10485760,  -- 10 MB
  ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Public read — stored values are public URLs rendered in run sheet / admin /
-- field detail. Discovery requires the unguessable object path.
DROP POLICY IF EXISTS ncn_photos_public_read ON storage.objects;
CREATE POLICY ncn_photos_public_read ON storage.objects
  FOR SELECT
  USING (bucket_id = 'ncn-photos');

-- Upload — field + ranger (the two creators) plus staff roles.
DROP POLICY IF EXISTS ncn_photos_staff_insert ON storage.objects;
CREATE POLICY ncn_photos_staff_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'ncn-photos'
    AND current_user_role() IN (
      'contractor-admin', 'contractor-staff',
      'client-admin', 'client-staff',
      'field', 'ranger'
    )
  );

-- Delete — same write roles, for cleanup of orphaned uploads.
DROP POLICY IF EXISTS ncn_photos_staff_delete ON storage.objects;
CREATE POLICY ncn_photos_staff_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'ncn-photos'
    AND current_user_role() IN (
      'contractor-admin', 'contractor-staff',
      'client-admin', 'client-staff',
      'field', 'ranger'
    )
  );
