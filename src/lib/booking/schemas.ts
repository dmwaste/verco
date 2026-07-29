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

// A single service line for the inline quantity editor (#380). Both the TARGET
// `items` and the #387.1 `expectedItems` concurrency baseline use this shape, and
// it mirrors the create-booking EF's per-service guard shape (service_id → summed
// no_services). no_services 0 is allowed on the target (drops that line via the
// EF smart-diff); the ≥1-remaining guard in updateBookingQuantities still forces
// at least one kept service.
export const QuantityEditItemSchema = z.object({
  service_id: z.string().uuid(),
  no_services: z.number().int().min(0).max(MAX_SERVICE_QTY),
})

export type QuantityEditItem = z.infer<typeof QuantityEditItemSchema>

// Phone helpers live in the mirrored single-brain module (src/lib/phone.ts ←
// supabase/functions/_shared/phone.ts). Re-exported here because this file was
// their historical home and app-wide imports point at it.
export {
  normaliseAuMobile,
  formatAuMobileDisplay,
  normalisePhone,
  isValidPhone,
  canonicaliseAuMobile,
  isSmsCapable,
} from '@/lib/phone'
import { canonicaliseAuMobile, isValidPhone, normalisePhone } from '@/lib/phone'

export const ContactSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(100),
  last_name: z.string().min(1, 'Last name is required').max(100),
  email: z.string().min(1, 'Email is required').email('Invalid email address'),
  // Accept any real phone — mobile / landline / 1300 / international (WMRC
  // #457). Canonicalise on store: mobiles → E.164 (+614…) so SMS works;
  // non-mobiles → formatting-stripped (SMS dispatch skips them cleanly and
  // the form warns the resident). One-brain rule as the strata contact path
  // (VER-315) — hint and stored value must never disagree.
  mobile: z
    .string()
    .trim()
    .min(1, 'Phone number is required')
    .max(25, 'Please enter a valid phone number')
    .refine(isValidPhone, 'Please enter a valid phone number (e.g. 0412 345 678)')
    .transform((val) => canonicaliseAuMobile(val) ?? normalisePhone(val)),
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
