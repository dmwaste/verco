import { z } from 'zod'

export const BookingItemSchema = z.object({
  service_id: z.string().uuid(),
  service_name: z.string(),
  category_name: z.string(),
  code: z.enum(['bulk', 'anc', 'id']),
  no_services: z.number().int().min(0),
  free_units: z.number().int().min(0),
  paid_units: z.number().int().min(0),
  unit_price_cents: z.number().int().min(0),
  line_charge_cents: z.number().int().min(0),
})

export type BookingItem = z.infer<typeof BookingItemSchema>

// Maximum quantity per service on a booking — mirrors the create-booking EF zod `.max(10)`.
export const MAX_SERVICE_QTY = 10

/**
 * Normalise an Australian mobile number to E.164 format (+614XXXXXXXX).
 * Accepts: 04XXXXXXXX, +614XXXXXXXX, 614XXXXXXXX
 * Returns null if invalid.
 */
export function normaliseAuMobile(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]+/g, '')

  // +614XXXXXXXX (already E.164)
  if (/^\+614\d{8}$/.test(digits)) return digits
  // 614XXXXXXXX (missing +)
  if (/^614\d{8}$/.test(digits)) return `+${digits}`
  // 04XXXXXXXX (local format)
  if (/^04\d{8}$/.test(digits)) return `+61${digits.slice(1)}`

  return null
}

/**
 * Format an E.164 AU mobile for display: 04XX XXX XXX
 */
export function formatAuMobileDisplay(e164: string): string {
  // +614XXXXXXXX → 04XX XXX XXX
  const local = '0' + e164.replace('+61', '')
  if (local.length !== 10) return e164
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
}

export const ContactSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(100),
  last_name: z.string().min(1, 'Last name is required').max(100),
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
  mobile: z
    .string()
    .min(1, 'Mobile number is required')
    .transform((val) => val.replace(/[\s\-()]+/g, ''))
    .refine(
      (val) => normaliseAuMobile(val) !== null,
      'Please enter a valid Australian mobile number (e.g. 0412 345 678)'
    )
    .transform((val) => normaliseAuMobile(val)!),
})

export type ContactFormData = z.infer<typeof ContactSchema>

// Resident-selectable collection locations. 'Other' is deliberately NOT here —
// it is staff-only (admin/on-behalf flow) and lives in STAFF_LOCATION_OPTION so
// it never renders on the resident-facing form.
export const LOCATION_OPTIONS = [
  'Front Verge',
  'Side Verge',
  'Driveway',
] as const

// Staff-only collection location, surfaced only in the on-behalf booking flow.
// Selecting it makes the driver-notes field mandatory.
export const STAFF_LOCATION_OPTION = 'Other' as const

export type LocationOption =
  | (typeof LOCATION_OPTIONS)[number]
  | typeof STAFF_LOCATION_OPTION
