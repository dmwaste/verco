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
-- is_active guard: never pin an inactive service as the swap target.
JOIN public.service green              ON green.category_id = bulk_cat.id
                                      AND green.waste_stream = 'green'
                                      AND green.is_active
WHERE ca.client_id = (SELECT id FROM public.client WHERE slug = 'kwn')
  AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4')
  AND NOT EXISTS (
    SELECT 1 FROM public.allocation_conversion_rule acr
    WHERE acr.from_allocation_rules_id = anc_rule.id
      AND acr.to_allocation_rules_id = bulk_rule.id
  );

-- Invariant check: every KWN area PRESENT in this database must end up with
-- exactly ONE conversion rule. Anchoring the expected side on the areas
-- themselves (not the same joins as the INSERT) catches BOTH failure shapes:
--   * an area missing an eligibility input (anc rule / bulk rule / active green
--     service) inserts nothing -> pairs < areas -> loud failure, instead of the
--     area silently dropping out of both sides of the comparison;
--   * a join fan-out (e.g. two active bulk 'green' services) double-inserts ->
--     pairs > areas -> loud failure (COUNT(*), deliberately not DISTINCT).
-- No is_active filter on the rule count: the NOT EXISTS guard above also
-- ignores is_active, so a re-run against a deliberately deactivated rule skips
-- the insert AND still passes here (predicates aligned; deactivation is
-- respected, never resurrected). Reset-safe: fresh `db reset` has no KWN areas
-- (seed.sql runs after migrations) -> 0 = 0.
DO $$
DECLARE
  v_area_count integer;
  v_rule_pairs integer;
BEGIN
  SELECT COUNT(*) INTO v_area_count
  FROM public.collection_area ca
  WHERE ca.client_id = (SELECT id FROM public.client WHERE slug = 'kwn')
    AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4');

  SELECT COUNT(*) INTO v_rule_pairs
  FROM public.allocation_conversion_rule acr
  JOIN public.allocation_rules fa ON fa.id = acr.from_allocation_rules_id
  JOIN public.collection_area ca  ON ca.id = fa.collection_area_id
  WHERE ca.client_id = (SELECT id FROM public.client WHERE slug = 'kwn')
    AND ca.code IN ('KWN-1', 'KWN-2', 'KWN-3', 'KWN-4');

  IF v_rule_pairs <> v_area_count THEN
    RAISE EXCEPTION
      'KWN conversion-rule re-seed mismatch: % KWN areas present but % conversion rules (want exactly one per area)',
      v_area_count, v_rule_pairs;
  END IF;
END $$;
