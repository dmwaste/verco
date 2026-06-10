-- Field/ranger mobile (plan 2026-06-10) — A1: waste stream on service.
--
-- A collection "stop" is booking × waste stream: crews collect general and
-- green in separate passes (kept segregated), and the Ancillary crew (KWNA)
-- collects mattress/e-waste/whitegoods in its own pass. The stream is a
-- first-class column on service rather than derived from category+name at
-- read time: category alone can't split Bulk into general/green, and
-- name-matching is brittle across tenants. NOT NULL forces every future
-- service seed to declare its stream.

CREATE TYPE waste_stream AS ENUM ('general', 'green', 'ancillary', 'illegal_dumping');

ALTER TABLE service ADD COLUMN waste_stream waste_stream;

COMMENT ON COLUMN service.waste_stream IS
  'Collection pass this service is picked up on. Stops (collection_stop) are '
  'generated per booking per stream. Bulk services split general/green; all '
  'Ancillary services share one pass.';

-- Seed from category code; within Bulk, anything named like "green" is the
-- green stream. Single-tenant naming today is exactly "General"/"Green" but
-- ILIKE keeps this robust for e.g. "Green Waste".
UPDATE service s
SET waste_stream = CASE
  WHEN c.code = 'anc' THEN 'ancillary'::waste_stream
  WHEN c.code = 'id'  THEN 'illegal_dumping'::waste_stream
  WHEN s.name ILIKE '%green%' THEN 'green'::waste_stream
  ELSE 'general'::waste_stream
END
FROM category c
WHERE c.id = s.category_id;

-- Explicit SET NOT NULL — the Supabase CLI infers nullability from column
-- metadata, not the seed; without this the generated TS type is `| null`.
ALTER TABLE service ALTER COLUMN waste_stream SET NOT NULL;
