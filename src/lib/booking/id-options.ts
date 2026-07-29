// Illegal dumping intake options — shared by the field (ranger) and admin
// (office staff) ID request forms. Both write these strings to
// booking.id_waste_types / booking.id_volume, so they must stay identical.

export const ID_WASTE_TYPES = [
  'General / Mixed',
  'Green Waste',
  'Whitegoods',
  'Mattress',
  'E-Waste',
] as const

// Display labels for stored id_waste_types values (#461 — WMRC wording).
// The stored strings are stable identifiers living on historical booking
// rows, so only the LABEL changes (service-name-rename gotcha: never key
// logic off display names). Unmapped values render as-is.
const ID_WASTE_TYPE_LABELS: Record<string, string> = {
  'General / Mixed': 'Bulk Waste',
}

/** Label for an id_waste_types value — every render site must use this. */
export const idWasteTypeLabel = (value: string): string =>
  ID_WASTE_TYPE_LABELS[value] ?? value

// Volumes are 3m³ allocation units (VER-258). The intake value is a crew-facing
// ESTIMATE only — actual allocations consumed are confirmed at collection
// closeout for billing (booking_item.actual_services, same as the MUD pattern).
export const ID_VOLUMES = [
  { label: '1 allocation', sub: '3m³' },
  { label: '2 allocations', sub: '6m³' },
  { label: '3+ allocations', sub: '9m³+' },
] as const

// Storage location for ID photos — both forms upload here, and the intake
// schema only accepts photo URLs from this bucket.
export const ID_PHOTOS_BUCKET = 'ncn-photos'
export const ID_PHOTOS_PREFIX = 'id-bookings'

