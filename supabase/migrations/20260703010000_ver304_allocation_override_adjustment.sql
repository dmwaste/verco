-- VER-304 — Support negative allocation adjustments + one canonical override row.
--
-- Two deliberate corrections vs the ticket's proposed migration:
--
--   1. The live CHECK constraint is named `allocation_override_set_remaining_check`,
--      NOT `allocation_override_extra_allocations_check`. It is a leftover from the
--      `set_remaining` -> `extra_allocations` column rename in
--      20260402160000_allocation_override_service_level.sql — a RENAME COLUMN
--      rewrites the column reference inside a constraint but does NOT rename the
--      constraint itself. Dropping the wrong name with IF EXISTS would silently
--      no-op and leave the `>= 0` guard in place, so negatives would still be
--      rejected. We drop the real name here.
--
--   2. Add a UNIQUE (property_id, service_id, fy_id) constraint. The ticket's
--      "one canonical row / no stacking" rule was app-level only, leaving a
--      check-then-insert TOCTOU race. The table is empty in prod, so this is safe
--      to add now; it turns a racy double-insert into a unique violation instead
--      of a duplicate row, and DB-enforces the stated design rule.

-- 1. Replace the surviving `>= 0` check with a symmetric range check.
ALTER TABLE public.allocation_override
  DROP CONSTRAINT IF EXISTS allocation_override_set_remaining_check;

ALTER TABLE public.allocation_override
  ADD CONSTRAINT allocation_override_extra_allocations_range
  CHECK (extra_allocations BETWEEN -999 AND 999);

-- 2. One canonical override per (property, service, FY).
ALTER TABLE public.allocation_override
  ADD CONSTRAINT allocation_override_property_service_fy_key
  UNIQUE (property_id, service_id, fy_id);
