// Mirrored to src/lib/contacts/contact-match.ts by scripts/sync-mirrors.sh — edit here.

export interface ContactIdentity {
  first_name: string | null
  last_name: string | null
  mobile_e164: string | null
}

export interface ExistingContact extends ContactIdentity {
  id: string
  /** Some booking on this contact is at a different property from the one being booked. */
  bookedElsewhere: boolean
  /** This contact is the strata contact of a MUD. */
  isStrataContact: boolean
}

export type ContactResolution =
  | { action: 'reuse'; contactId: string }
  | { action: 'update'; contactId: string }
  | { action: 'insert' }

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

function samePerson(a: ContactIdentity, b: ContactIdentity): boolean {
  return (
    norm(a.first_name) === norm(b.first_name) &&
    norm(a.last_name) === norm(b.last_name) &&
    norm(a.mobile_e164) === norm(b.mobile_e164)
  )
}

/**
 * How a booking attaches its contact, given every contacts row already carrying
 * the entered email (oldest first).
 *
 * A shared email is not always a shared person: staff booking residents by phone
 * put one office address on hundreds of people, and each booking rewrote that
 * row's name + mobile, so every other booking on it texted the newest resident
 * (WMRC, 12/10/2026). A row may only be rewritten when the change can't reach
 * anyone else's booking:
 *   - same name + mobile already on a row → reuse it, untouched
 *   - the signed-in resident booking for themselves, one row → update (own correction)
 *   - one row used only at this property and not a strata contact → update
 *     (same household: a partner on the shared email, or a new mobile)
 *   - anything else → insert a new row for this booking
 */
export function resolveContact(
  existing: ExistingContact[],
  entered: ContactIdentity,
  enteredBySelf: boolean,
): ContactResolution {
  const match = existing.find((c) => samePerson(c, entered))
  if (match) return { action: 'reuse', contactId: match.id }
  if (enteredBySelf && existing.length === 1) return { action: 'update', contactId: existing[0]!.id }
  const local = existing.filter((c) => !c.bookedElsewhere && !c.isStrataContact)
  if (local.length === 1) return { action: 'update', contactId: local[0]!.id }
  return { action: 'insert' }
}
