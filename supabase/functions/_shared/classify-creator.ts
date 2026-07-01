/**
 * CBSTAMP — derive `booking.created_via` from the acting user (VER-179 §4.2).
 *
 * Pure + deterministic: no Supabase, no network, no wall-clock reads. Every
 * input is a stored/resolved fact about the booking request passed in; the
 * result is fully unit-testable. The `create-booking` Edge Function (Phase 3)
 * calls this after it resolves the acting user + the booking contact, then
 * passes the result to `create_booking_with_capacity_check(... p_created_via)`.
 *
 * `created_via` is immutable, stamped at INSERT. It is the only correct
 * self-service signal: the `created_by → user_roles.role` join is rejected
 * (RLS hides resident roles from admins, and roles mutate over time), and the
 * `on_behalf=true` URL param is client-controlled and untrusted (spec §3.6).
 *
 * Classification precedence (role wins over the email-match path so a staff
 * member booking for their own email is still `admin`, per the plan):
 *   1. No acting user (no session) ⇒ `resident` — guest OTP self-booking.
 *   2. Staff role ⇒ `admin` — on-behalf booking (role wins regardless of email).
 *   3. Ranger role ⇒ `ranger`.
 *   4. Acting email matches the contact email ⇒ `resident` — authed resident
 *      booking for themselves.
 *   5. Acting email present but mismatches the contact email ⇒ `admin` —
 *      acting on behalf of a different person (collision / family member).
 *   6. Otherwise (authed, no role, no comparable email) ⇒ `system`.
 */

/** The channel a booking was created through (the `booking.created_via` value). */
export type CreatedVia = 'resident' | 'admin' | 'ranger' | 'system'

/**
 * Roles that classify a booking as `admin` (staff acting on behalf of a
 * resident). Mirrors `STAFF_ROLES` in `src/lib/auth/roles.ts`; kept local so the
 * classifier has no incidental coupling beyond the channel set it cares about.
 * `ranger` is deliberately NOT here — a ranger gets its own `created_via`.
 */
export const CREATOR_STAFF_ROLES = [
  'contractor-admin',
  'contractor-staff',
  'client-admin',
  'client-staff',
] as const

const STAFF_ROLE_SET: ReadonlySet<string> = new Set(CREATOR_STAFF_ROLES)

export interface ClassifyCreatorInput {
  /** Role of the acting user (`user_roles.role`), or null when none/unknown. */
  actingUserRole?: string | null
  /** Email of the acting user (the authenticated session), or null. */
  actingUserEmail?: string | null
  /** Email captured on the booking contact, or null. */
  contactEmail?: string | null
  /**
   * Whether an authenticated session is acting. `false` ⇒ guest OTP / no
   * acting user ⇒ always `resident`, regardless of any stray field values.
   */
  hasSession: boolean
}

export interface ClassifyCreatorResult {
  createdVia: CreatedVia
}

/** Normalise an email for comparison; empty/whitespace-only ⇒ null (absent). */
function normaliseEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

/**
 * Classify the channel a booking was created through.
 *
 * @param input acting user role/email, booking contact email, session flag
 * @returns `{ createdVia }` — one of `resident | admin | ranger | system`
 */
export function classifyCreator(input: ClassifyCreatorInput): ClassifyCreatorResult {
  // 1. No acting user (guest OTP / no session) ⇒ resident self-booking.
  if (!input.hasSession) return { createdVia: 'resident' }

  const role = typeof input.actingUserRole === 'string' ? input.actingUserRole.trim() : ''

  // 2. Staff role wins over the email-match path (staff booking for their own
  //    email is still admin).
  if (STAFF_ROLE_SET.has(role)) return { createdVia: 'admin' }

  // 3. Ranger gets its own channel, also independent of the email comparison.
  if (role === 'ranger') return { createdVia: 'ranger' }

  // 4/5. Compare the acting user's email to the booking contact's email.
  const actingEmail = normaliseEmail(input.actingUserEmail)
  const contactEmail = normaliseEmail(input.contactEmail)

  if (actingEmail !== null && contactEmail !== null) {
    return { createdVia: actingEmail === contactEmail ? 'resident' : 'admin' }
  }

  // 6. Authed, no role, no comparable email ⇒ system.
  return { createdVia: 'system' }
}
