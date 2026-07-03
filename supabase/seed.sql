-- =============================================================================
-- Verco v2 — Seed Data
-- =============================================================================
-- Idempotent — safe to run multiple times. Uses ON CONFLICT to skip duplicates.
-- Looks up existing contractor/client/category IDs rather than hardcoding them.
--
-- Execute against remote:
--   Use Supabase MCP execute_sql or the SQL Editor in the Supabase dashboard.
-- =============================================================================

DO $$
DECLARE
  v_contractor_id  uuid;
  v_client_id      uuid;
  v_fy_id          uuid;
  v_area1_id       uuid;
  v_area2_id       uuid;
  v_area3_id       uuid;
  v_area4_id       uuid;
  v_cat_general    uuid;
  v_cat_green      uuid;
  v_cat_mattress   uuid;
  v_cat_ewaste     uuid;
  v_cat_whitegoods uuid;
  v_st_general     uuid;
  v_st_green       uuid;
  v_st_mattress    uuid;
  v_st_ewaste      uuid;
  v_st_whitegoods  uuid;
BEGIN

-- ── Contractor ──────────────────────────────────────────────────────────────
INSERT INTO contractor (name, slug, is_active)
VALUES ('D&M Waste Management', 'dm', true)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO v_contractor_id FROM contractor WHERE slug = 'dm';

-- ── Client ──────────────────────────────────────────────────────────────────
INSERT INTO client (contractor_id, name, slug, is_active, primary_colour, service_name, show_powered_by)
VALUES (
  v_contractor_id,
  'City of Kwinana',
  'kwn',
  true,
  '#293F52',
  'Verge Collection Bookings',
  true
)
ON CONFLICT (slug) DO NOTHING;

SELECT id INTO v_client_id FROM client WHERE slug = 'kwn';

-- ── Financial Year ──────────────────────────────────────────────────────────
INSERT INTO financial_year (label, start_date, end_date, rollover_date, is_current)
VALUES ('FY2025-26', '2025-07-01', '2026-06-30', '2026-07-01', true)
ON CONFLICT DO NOTHING;

SELECT id INTO v_fy_id FROM financial_year WHERE label = 'FY2025-26';

-- ── Collection Areas ────────────────────────────────────────────────────────
INSERT INTO collection_area (client_id, contractor_id, name, code, dm_job_code, is_active)
VALUES
  (v_client_id, v_contractor_id, 'Kwinana Area 1', 'KWN-1', 'KWN-V-1', true),
  (v_client_id, v_contractor_id, 'Kwinana Area 2', 'KWN-2', 'KWN-V-2', true),
  (v_client_id, v_contractor_id, 'Kwinana Area 3', 'KWN-3', 'KWN-V-3', true),
  (v_client_id, v_contractor_id, 'Kwinana Area 4', 'KWN-4', 'KWN-V-4', true)
ON CONFLICT (client_id, code) DO NOTHING;

SELECT id INTO v_area1_id FROM collection_area WHERE code = 'KWN-1' AND client_id = v_client_id;
SELECT id INTO v_area2_id FROM collection_area WHERE code = 'KWN-2' AND client_id = v_client_id;
SELECT id INTO v_area3_id FROM collection_area WHERE code = 'KWN-3' AND client_id = v_client_id;
SELECT id INTO v_area4_id FROM collection_area WHERE code = 'KWN-4' AND client_id = v_client_id;

-- ── Categories ──────────────────────────────────────────────────────────────
INSERT INTO category (name, capacity_bucket)
VALUES
  ('General',    'bulk'),
  ('Green',      'bulk'),
  ('Mattress',   'anc'),
  ('E-Waste',    'anc'),
  ('Whitegoods', 'anc')
ON CONFLICT (name) DO NOTHING;

SELECT id INTO v_cat_general    FROM category WHERE name = 'General';
SELECT id INTO v_cat_green      FROM category WHERE name = 'Green';
SELECT id INTO v_cat_mattress   FROM category WHERE name = 'Mattress';
SELECT id INTO v_cat_ewaste     FROM category WHERE name = 'E-Waste';
SELECT id INTO v_cat_whitegoods FROM category WHERE name = 'Whitegoods';

-- ── Service Types ───────────────────────────────────────────────────────────
INSERT INTO service_type (name, category_id, is_active)
VALUES
  ('General',    v_cat_general,    true),
  ('Green',      v_cat_green,      true),
  ('Mattress',   v_cat_mattress,   true),
  ('E-Waste',    v_cat_ewaste,     true),
  ('Whitegoods', v_cat_whitegoods, true)
ON CONFLICT DO NOTHING;

SELECT id INTO v_st_general    FROM service_type WHERE name = 'General'    AND category_id = v_cat_general;
SELECT id INTO v_st_green      FROM service_type WHERE name = 'Green'      AND category_id = v_cat_green;
SELECT id INTO v_st_mattress   FROM service_type WHERE name = 'Mattress'   AND category_id = v_cat_mattress;
SELECT id INTO v_st_ewaste     FROM service_type WHERE name = 'E-Waste'    AND category_id = v_cat_ewaste;
SELECT id INTO v_st_whitegoods FROM service_type WHERE name = 'Whitegoods' AND category_id = v_cat_whitegoods;

-- ── Allocation Rules (KWN-1) ────────────────────────────────────────────────
INSERT INTO allocation_rules (collection_area_id, category_id, max_collections)
VALUES
  (v_area1_id, v_cat_general,    2),
  (v_area1_id, v_cat_green,      2),
  (v_area1_id, v_cat_mattress,   1),
  (v_area1_id, v_cat_ewaste,     3),
  (v_area1_id, v_cat_whitegoods, 2)
ON CONFLICT (collection_area_id, category_id) DO NOTHING;

-- ── Service Rules (KWN-1) ───────────────────────────────────────────────────
INSERT INTO service_rules (collection_area_id, service_type_id, max_collections, extra_unit_price)
VALUES
  (v_area1_id, v_st_general,    2, 89.67),
  (v_area1_id, v_st_green,      2, 89.67),
  (v_area1_id, v_st_mattress,   1, 45.00),
  (v_area1_id, v_st_ewaste,     3, 38.36),
  (v_area1_id, v_st_whitegoods, 2, 38.36)
ON CONFLICT (collection_area_id, service_type_id) DO NOTHING;

-- ── Collection Dates (KWN-1) ────────────────────────────────────────────────
INSERT INTO collection_date (
  collection_area_id, date, is_open, for_mud,
  bulk_capacity_limit, bulk_units_booked, bulk_is_closed,
  anc_capacity_limit,  anc_units_booked,  anc_is_closed,
  id_capacity_limit,   id_units_booked,   id_is_closed
)
VALUES
  (v_area1_id, '2026-04-01', true, false, 60, 0, false, 60, 0, false, 10, 0, false),
  (v_area1_id, '2026-04-08', true, false, 60, 0, false, 60, 0, false, 10, 0, false),
  (v_area1_id, '2026-04-22', true, false, 60, 0, false, 60, 0, false, 10, 0, false)
ON CONFLICT DO NOTHING;

-- ── Collection Schedule (KWN-1..4) ──────────────────────────────────────────
-- Mirrors migration 20260703085526_seed_kwn_collection_schedule.sql so the
-- local/E2E stack matches prod: one weekday per zone (Mon-Thu), unpooled,
-- bulk 70 / anc 60 / id 10. Seeded here (not by the migration) because the
-- migration runs BEFORE seed.sql creates these areas, so it no-ops on reset.
INSERT INTO collection_schedule (
  collection_area_id, day_of_week, bulk_capacity_limit, anc_capacity_limit, id_capacity_limit
)
VALUES
  (v_area1_id, 1, 70, 60, 10),  -- Mon
  (v_area2_id, 2, 70, 60, 10),  -- Tue
  (v_area3_id, 3, 70, 60, 10),  -- Wed
  (v_area4_id, 4, 70, 60, 10)   -- Thu
ON CONFLICT (collection_area_id, day_of_week) DO NOTHING;

-- ── Eligible Properties (KWN-1) ─────────────────────────────────────────────
INSERT INTO eligible_properties (collection_area_id, address, formatted_address, latitude, longitude, has_geocode, is_mud)
VALUES
  (v_area1_id, '23 Leda Blvd',       '23 Leda Blvd, Wellard WA 6170',           -32.2158, 115.7811, true, false),
  (v_area1_id, '14 Macdonald Cres',  '14 Macdonald Cres, Kwinana Town WA 6167', -32.2415, 115.7712, true, false),
  (v_area1_id, '7 Bertram Rd',       '7 Bertram Rd, Bertram WA 6167',            -32.2340, 115.8490, true, false),
  (v_area1_id, '91 Gilmore Ave',     '91 Gilmore Ave, Calista WA 6167',          -32.2370, 115.7780, true, false),
  (v_area1_id, '3 Peel Rd',          '3 Peel Rd, Parmelia WA 6167',              -32.2500, 115.7830, true, false),
  (v_area1_id, '55 Challenger Pde',  '55 Challenger Pde, Wandi WA 6167',         -32.2050, 115.8130, true, false),
  (v_area1_id, '12 Acacia Dr',       '12 Acacia Dr, Medina WA 6167',             -32.2310, 115.7890, true, false),
  (v_area1_id, '6 Chisham Ave',      '6 Chisham Ave, Kwinana Town WA 6167',      -32.2430, 115.7740, true, false),
  (v_area1_id, '18 Sulphur Rd',      '18 Sulphur Rd, Wellard WA 6170',           -32.2180, 115.7850, true, false),
  (v_area1_id, '42 Orelia Ave',      '42 Orelia Ave, Orelia WA 6167',             -32.2290, 115.7910, true, false)
ON CONFLICT DO NOTHING;

END $$;
