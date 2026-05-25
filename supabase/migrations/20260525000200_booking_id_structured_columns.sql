-- Structured columns for Illegal Dumping (ID) bookings.
--
-- Until now the ranger ID form crammed waste types, volume and a photo *count*
-- into the free-text `notes` field, and the actual photo URLs were never
-- persisted. These columns make the evidence queryable and renderable on the
-- run sheet, field closeout and admin booking detail. They are empty/null for
-- every non-ID booking type, mirroring `non_conformance_notice.photos`.

ALTER TABLE booking
  ADD COLUMN IF NOT EXISTS photos         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS id_waste_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS id_volume      text;

COMMENT ON COLUMN booking.photos IS 'Evidence photo URLs (ncn-photos bucket). Populated for Illegal Dumping bookings.';
COMMENT ON COLUMN booking.id_waste_types IS 'Illegal Dumping: ranger-selected waste type tags.';
COMMENT ON COLUMN booking.id_volume IS 'Illegal Dumping: ranger-estimated volume label.';
