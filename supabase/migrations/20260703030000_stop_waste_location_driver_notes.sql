-- Denormalise waste placement + driver instructions onto the stop.
--
-- The push-orders-to-optimoroute EF builds each order's notes block from the
-- stop row alone (Pass 2 never re-joins booking), and the field run-sheet reads
-- the same denormalised row so crews never join booking -> contacts (PII
-- structural exclusion). address/services_summary already live here; these two
-- follow the same pattern so both the routing-engine notes and the crew UI can
-- show WHERE on the property the waste sits and WHAT the resident asked for.

ALTER TABLE collection_stop
  ADD COLUMN waste_location text,
  ADD COLUMN driver_notes text;

COMMENT ON COLUMN collection_stop.waste_location IS
  'Denormalised booking.location — where on the property the waste sits (Front Verge / Side Verge / Driveway / Other). Rendered on the OptimoRoute order notes and the field run-sheet.';

COMMENT ON COLUMN collection_stop.driver_notes IS
  'Denormalised booking.notes — resident free-text instructions for the crew. Rendered on the OptimoRoute order notes and the field run-sheet. Free text; may occasionally contain resident-entered PII.';
