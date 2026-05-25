-- Seed the single service under the Illegal Dumping (`id`) category.
--
-- Bulk has General/Green and Ancillary has Mattress/E-Waste/Whitegoods, but the
-- `id` category had no service row. The ranger ID booking action resolves the
-- service via `service ... WHERE category.code = 'id'` and fails with "ID
-- service not configured" without one. ID is a single undifferentiated stream
-- (PRD §4.2: "Illegal Dumping (any stream) -> id"), so one service suffices.

INSERT INTO service (name, category_id)
SELECT 'Illegal Dumping', c.id
FROM category c
WHERE c.code = 'id'
  AND NOT EXISTS (
    SELECT 1 FROM service s WHERE s.category_id = c.id
  );
