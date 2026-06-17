-- Per-tenant favicon support (PR-A of the favicon work).
--
-- Adds a nullable favicon_url to `client`. Served on resident (public) pages via
-- generateMetadata in PR-B; admin/field/landing keep the Verco default favicon.
--
-- RLS: no policy change required.
--   * Read  — `client_public_select (USING true)` already exposes the column to the
--             unauthenticated /book flow, which is exactly what the (public) favicon
--             fetch needs.
--   * Write — `client_contractor_admin_update` / `client_client_admin_update` are
--             row-level (has_role + contractor_id) with no column enumeration and no
--             column-level GRANT, so the new column is covered.
-- Audit: `client` already has audit_trigger; the human-readable label is added in PR-B.

ALTER TABLE client ADD COLUMN favicon_url text;

COMMENT ON COLUMN client.favicon_url IS
  'Public URL of the client''s square favicon (PNG/SVG) in the client-assets bucket. NULL = inherit the Verco default favicon.';
