-- Reconcile category.code drift: 'coll' -> 'bulk'.
--
-- The schema-of-record (20260326180000_schema_restructure.sql) seeds the
-- Collection/Bulk category with code = 'bulk':
--   INSERT INTO category (name, code, ...) VALUES ('Bulk', 'bulk', ...);
-- Production data had drifted to code = 'coll' (an out-of-band write — there is
-- no updated_at trigger on category, so the drift left updated_at == created_at).
--
-- category.code is overloaded as the capacity-bucket key throughout the app:
--   * book/services/services-form.tsx groups services on `code === 'bulk'`
--   * book/date/date-form.tsx does buckets.add(category.code) then
--     buckets.has('bulk') against the bulk_* capacity columns
--   * admin/page.tsx accumulates bulkMax on `cat.code === 'bulk'`
--   * lib/booking/schemas.ts BookingItem.code is z.enum(['bulk','anc','id'])
-- It MUST mirror the capacity_bucket enum ('bulk','anc','id') — and 'anc'/'id'
-- already match; only the Collection row diverged. With code = 'coll', the two
-- Collection services (Bulk Waste, Green Waste) were silently dropped from the
-- booking form (an empty Services step) and excluded from date-capacity
-- filtering. Nothing in the codebase or any DB function references 'coll'.
--
-- Idempotent: re-running is a no-op once the row is 'bulk'. The UNIQUE(code)
-- constraint is safe because no 'bulk' row currently exists.
UPDATE public.category
SET code = 'bulk'
WHERE code = 'coll';
