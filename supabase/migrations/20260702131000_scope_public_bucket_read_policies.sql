-- ============================================================================
-- VER-289 — stop public/resident listing of ncn-photos + client-assets
-- ============================================================================
-- Supabase advisor lint 0025 (public_bucket_allows_listing): both buckets are
-- PUBLIC (object URLs serve via /object/public/ with no policy check) but also
-- carried a broad SELECT policy on storage.objects for the `public` role —
-- which is what lets ANY caller (anon or any authenticated resident) LIST
-- every file via the storage API. NCN photos are resident-property enforcement
-- images; enumerable listing is more exposure than intended.
--
-- App audit (02/07/2026): no `.list()` calls anywhere in src/ or EFs; all
-- reads use getPublicUrl() (public URL endpoint — unaffected by policies).
-- The one API path that can exercise SELECT is branding-tab.tsx's
-- `.upload(..., { upsert: true })` on client-assets — staff-only UI — so the
-- public SELECT is REPLACED with a staff-scoped SELECT rather than dropped
-- outright, mirroring each bucket's existing write-policy role list
-- (ncn_photos_staff_delete / bug_report_attachments_staff_read patterns).
-- INSERT/UPDATE/DELETE policies are untouched.
--
-- Net effect: object URLs keep working everywhere; staff API reads keep
-- working; anon AND resident-authenticated listing is gone.
-- Idempotent: safe to re-apply.
-- ============================================================================

DROP POLICY IF EXISTS "ncn_photos_public_read" ON storage.objects;
DROP POLICY IF EXISTS "ncn_photos_staff_read" ON storage.objects;
CREATE POLICY "ncn_photos_staff_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'ncn-photos'
    AND public.current_user_role() = ANY (ARRAY[
      'contractor-admin', 'contractor-staff',
      'client-admin', 'client-staff',
      'field', 'ranger'
    ]::public.app_role[])
  );

DROP POLICY IF EXISTS "client_assets_public_read" ON storage.objects;
DROP POLICY IF EXISTS "client_assets_staff_read" ON storage.objects;
CREATE POLICY "client_assets_staff_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'client-assets'
    AND public.current_user_role() = ANY (ARRAY[
      'contractor-admin', 'contractor-staff',
      'client-admin', 'client-staff'
    ]::public.app_role[])
  );
