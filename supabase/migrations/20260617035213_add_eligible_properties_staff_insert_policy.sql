-- Mirrors eligible_properties_staff_update (which had no INSERT counterpart),
-- so contractor/client admin+staff can INSERT eligible_properties into areas
-- under clients they can access. Unblocks the admin CSV importer.
--
-- PROVENANCE: this policy was applied directly to prod on 2026-06-17 (version
-- 20260617035213) via Supabase MCP apply_migration, which stamps version=now()
-- and never wrote a repo file — the documented anti-pattern in memory
-- mcp-apply-migration-version-sync.md. This file reconciles the repo to that
-- already-applied prod state: the version matches the remote
-- schema_migrations entry, so `db push` treats it as applied and SKIPS
-- re-execution (it only restores repo tracking + fresh-DB reproducibility).
-- The `drop policy if exists` guard keeps a `db reset` on a fresh database
-- idempotent.
drop policy if exists eligible_properties_staff_insert on public.eligible_properties;
create policy eligible_properties_staff_insert
on public.eligible_properties
for insert
to public
with check (
  (current_user_role() = any (array['contractor-admin'::app_role,'contractor-staff'::app_role,'client-admin'::app_role,'client-staff'::app_role]))
  and (collection_area_id in (
      select collection_area.id from collection_area
      where collection_area.client_id in (select accessible_client_ids() as accessible_client_ids)))
  and user_sub_client_allows_area(collection_area_id)
);
