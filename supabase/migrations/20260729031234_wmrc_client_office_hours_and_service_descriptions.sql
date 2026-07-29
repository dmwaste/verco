-- WMRC Stage 2 punch-list items 1 + 2 (#454, #455): per-tenant contact-page
-- office hours and per-tenant "what we collect" service description overrides.
--
-- Both surfaces were hardcoded and shared across tenants:
--   * Hours: "Mon–Fri 8am–5pm AWST" in (public)/contact/page.tsx — WMRC needs
--     8:30am–4:30pm while Kwinana keeps the current hours.
--   * Service descriptions: SERVICE_DESCRIPTIONS map in (public)/page.tsx keyed
--     by service NAME — and both tenants share the name "Bulk Waste", so a
--     description column on the global `service` table cannot diverge them.
--     A per-client jsonb override map (same pattern as client.faq_items) can.
--
-- Consumers land in a follow-up PR after this releases (Types Freshness split).
-- NULL office_hours / missing map keys keep today's hardcoded fallbacks, so
-- nothing changes for a tenant until its row is populated.

ALTER TABLE public.client
  ADD COLUMN IF NOT EXISTS office_hours text,
  ADD COLUMN IF NOT EXISTS service_descriptions jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.client.office_hours IS
  'Contact-page hours line, e.g. "Mon–Fri 8:30am–4:30pm AWST". NULL = app fallback.';
COMMENT ON COLUMN public.client.service_descriptions IS
  'Per-tenant overrides for the landing-page "what we collect" tiles, keyed by service name. Missing key = app fallback copy.';

-- Backfills. Keyed on slug so a fresh `db reset` (clients not migration-seeded)
-- no-ops cleanly; predicated so a re-run touches nothing.
UPDATE public.client
SET office_hours = 'Mon–Fri 8am–5pm AWST'
WHERE slug = 'kwn' AND office_hours IS NULL;

UPDATE public.client
SET office_hours = 'Mon–Fri 8:30am–4:30pm AWST'
WHERE slug = 'vergevalet' AND office_hours IS NULL;

-- WMRC-requested bulk examples (Jared Crowe agenda, 28/07/2026).
UPDATE public.client
SET service_descriptions = service_descriptions
      || jsonb_build_object('Bulk Waste', 'Broken furniture, household appliances, junk items')
WHERE slug = 'vergevalet'
  AND NOT service_descriptions ? 'Bulk Waste';
