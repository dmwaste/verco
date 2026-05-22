-- Drop the MUD unit_count minimum constraint.
--
-- The original CHECK (unit_count >= 8) encoded a wrong assumption — there is
-- no set minimum unit count for MUDs; thresholds vary per council. unit_count=0
-- is valid and means "not yet recorded". The application layer should treat 0
-- as unknown and prompt admins to fill it in before enabling bookings.

ALTER TABLE eligible_properties
  DROP CONSTRAINT IF EXISTS eligible_properties_mud_unit_count_check;
