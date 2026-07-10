-- Re-seed the Kwinana allocation swap (3 Ancillary -> 1 Green) conversion rules.
--
-- Why this exists
-- ----------------
-- The original seed in 20260605000000_allocation_swap.sql inserted 4 rows
-- (KWN-1..KWN-4) into allocation_conversion_rule and was confirmed on prod
-- after release #149. Those rows are now GONE, for two compounding reasons:
--
--   1. CASCADE wipe. allocation_conversion_rule.{from,to}_allocation_rules_id
--      are ON DELETE CASCADE references to allocation_rules. On 2026-07-03 the
--      KWN allocation_rules were deleted and re-created (part of the KWN
--      reconciliation rebuild — new row ids, created_at 2026-07-03 02:50-02:51).
--      Deleting the old allocation_rules cascade-deleted all 4 conversion rules.
--      A one-shot seed migration cannot self-heal, so the table has sat empty
--      ever since and the "swap for green" option silently never renders for any
--      Kwinana property (services-form.tsx gates on a non-null conversionRule).
--
--   2. Rename brittleness. The original seed matched the Green service by
--      display name (service.name = 'Green'). That service was since renamed to
--      'Green Waste' (waste_stream = 'green'), so even re-running the original
--      seed verbatim would insert 0 rows. This re-seed keys the Green target off
--      the immutable waste_stream instead of the display name — see memory
--      service-name-rename-gotcha (key off waste_stream/category.code, never a
--      display name).
--
-- Idempotent: guarded with NOT EXISTS on (from_allocation_rules_id,
-- to_allocation_rules_id) — allocation_conversion_rule has no unique constraint
-- to ON CONFLICT against — so a re-run inserts nothing for areas already covered.
--
-- Reset-safe: the KWN client + areas are NOT created by any migration (prod was
-- populated by scripts/import-kwn-properties.ts; the local/E2E stack by
-- supabase/seed.sql, which runs AFTER migrations). During a fresh
-- `supabase db reset` the JOINs resolve to nothing, the INSERT is a harmless
-- no-op, and the invariant check below passes at 0 = 0. On prod it is 4 = 4.
INSERT INTO public.allocation_conversion_rule
  (from_allocation_rules_id, to_allocation_rules_id, to_service_id, from_units, to_units)
SELECT anc_rule.id, bulk_rule.id, green.id, 3, 1
FROM public.collection_area ca
JOIN public.allocation_rules anc_rule  ON anc_rule.collection_area_id = ca.id
JOIN public.category anc_cat           ON anc_cat.id = anc_rule.category_id AND anc_cat.code = 'anc'
JOIN public.allocation_rules bulk_rule ON bulk_rule.collection_area_id = ca.id
JOIN public.category bulk_cat          ON bulk_cat.id = bulk_rule.category_id AND bulk_cat.code = 'bulk'
-- Rename-proof: match the Green service by waste_stream, not display name.
JOIN public.service green              ON green.category_id = bulk_cat.id AND green.waste_stream = 'green'
WHERE ca.client_id = (SELECT id FROM public.client WHERE slug = 'kwn')
  AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4')
  AND NOT EXISTS (
    SELECT 1 FROM public.allocation_conversion_rule acr
    WHERE acr.from_allocation_rules_id = anc_rule.id
      AND acr.to_allocation_rules_id = bulk_rule.id
  );

-- Invariant check: every KWN area that CAN carry a swap (has an anc rule, a bulk
-- rule, and a bulk Green service) must now have an active conversion rule. On
-- prod that is 4 = 4; on a fresh reset (no KWN areas) it is 0 = 0. Asserting the
-- invariant rather than a hardcoded count keeps the migration reset-safe.
DO $$
DECLARE
  v_eligible_areas integer;
  v_rule_areas     integer;
BEGIN
  SELECT COUNT(DISTINCT ca.id) INTO v_eligible_areas
  FROM public.collection_area ca
  JOIN public.allocation_rules anc_rule  ON anc_rule.collection_area_id = ca.id
  JOIN public.category anc_cat           ON anc_cat.id = anc_rule.category_id AND anc_cat.code = 'anc'
  JOIN public.allocation_rules bulk_rule ON bulk_rule.collection_area_id = ca.id
  JOIN public.category bulk_cat          ON bulk_cat.id = bulk_rule.category_id AND bulk_cat.code = 'bulk'
  JOIN public.service green              ON green.category_id = bulk_cat.id AND green.waste_stream = 'green'
  WHERE ca.client_id = (SELECT id FROM public.client WHERE slug = 'kwn')
    AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4');

  SELECT COUNT(DISTINCT fa.collection_area_id) INTO v_rule_areas
  FROM public.allocation_conversion_rule acr
  JOIN public.allocation_rules fa ON fa.id = acr.from_allocation_rules_id
  JOIN public.collection_area ca  ON ca.id = fa.collection_area_id
  WHERE acr.is_active
    AND ca.client_id = (SELECT id FROM public.client WHERE slug = 'kwn')
    AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4');

  IF v_rule_areas <> v_eligible_areas THEN
    RAISE EXCEPTION
      'KWN conversion-rule re-seed mismatch: % swap-eligible areas but % have an active rule',
      v_eligible_areas, v_rule_areas;
  END IF;
END $$;
