// scripts/lib/reminder-catchup.ts
//
// Pure planning for scripts/send-reminder-catchup.ts — which open bookings
// missed their collection reminder and should get a late one.
//
// A booking is owed a catch-up when its reminder day has arrived (collection −
// client.sms_reminder_days_before ≤ today) but its collection is still ahead
// (collection > today), and no collection_reminder was sent on ANY channel.
// Illegal Dumping bookings never get resident notifications (dispatch skips
// them), and bookings on a shared/staff contact are held back so a reminder
// can't go to the wrong person (ADR 0027 / the 12/10 Magix incident).

export interface CatchupBooking {
  id: string
  ref: string
  clientSlug: string
  reminderDays: number
  type: string
  contactId: string | null
  dates: string[] // YYYY-MM-DD collection dates across the booking's items
}

export interface CatchupPlan {
  send: Array<CatchupBooking & { earliest: string }>
  excludedSharedContact: Array<CatchupBooking & { earliest: string }>
}

// The WMRC office placeholder row that 270+ migrated residents were folded onto.
export const SHARED_WMRC_CONTACT_ID = '8220f1bc-7c48-4bd1-ab1c-001d756993a5'
// Operator / council / strata-manager domains entered as a resident's email
// (matched on whole domain labels, so a resident domain merely containing
// "wmrc" isn't held back).
const SHARED_EMAIL_DOMAIN = /(^|\.)(dmwaste\.com\.au|dmwastemanagement\.com\.au|verco\.au|magixstrata\.com\.au)$|(^|\.)wmrc\./

export function isSharedContact(id: string, email: string | null): boolean {
  if (id === SHARED_WMRC_CONTACT_ID) return true
  const domain = (email ?? '').trim().toLowerCase().split('@')[1] ?? ''
  return SHARED_EMAIL_DOMAIN.test(domain)
}

export function addDays(yyyymmdd: string, n: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Bookings whose reminder day has come but whose collection hasn't. */
export function reminderDue(bookings: CatchupBooking[], today: string): Array<CatchupBooking & { earliest: string }> {
  const out: Array<CatchupBooking & { earliest: string }> = []
  for (const b of bookings) {
    if (b.type === 'Illegal Dumping') continue
    const earliest = [...b.dates].sort()[0]
    if (!earliest) continue
    if (earliest <= today) continue
    if (addDays(earliest, -b.reminderDays) > today) continue
    out.push({ ...b, earliest })
  }
  return out
}

export function planReminderCatchup(
  bookings: CatchupBooking[],
  today: string,
  alreadyReminded: Set<string>,
  sharedContactIds: Set<string>,
): CatchupPlan {
  const plan: CatchupPlan = { send: [], excludedSharedContact: [] }
  for (const b of reminderDue(bookings, today)) {
    if (alreadyReminded.has(b.id)) continue
    if (b.contactId && sharedContactIds.has(b.contactId)) plan.excludedSharedContact.push(b)
    else plan.send.push(b)
  }
  return plan
}
