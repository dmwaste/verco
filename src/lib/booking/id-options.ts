// Illegal dumping intake options — shared by the field (ranger) and admin
// (office staff) ID request forms. Both write these strings to
// booking.id_waste_types / booking.id_volume, so they must stay identical.

export const ID_WASTE_TYPES = [
  'General / Mixed',
  'Green Waste',
  'Whitegoods',
  'Mattress',
  'E-Waste',
  'Hazardous',
  'Construction / Demolition',
] as const

export const ID_VOLUMES = [
  { label: 'Small', sub: '< 1 ute' },
  { label: 'Medium', sub: '1–3 utes' },
  { label: 'Large', sub: '> 3 utes' },
] as const

// Storage location for ID photos — both forms upload here, and the intake
// schema only accepts photo URLs from this bucket.
export const ID_PHOTOS_BUCKET = 'ncn-photos'
export const ID_PHOTOS_PREFIX = 'id-bookings'

