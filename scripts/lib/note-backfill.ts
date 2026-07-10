// scripts/lib/note-backfill.ts
//
// Pure planning logic for the one-time VV Waste_Notes → booking.notes backfill.
//
// The VV (COT/MOS/PEP) go-live import mapped Airtable Waste_Location but dropped
// the free-text Waste_Notes (resident placement instructions the crew reads via
// the run sheet + OptimoRoute order). This module diffs the two sides and, for
// every Verco booking whose notes are blank, proposes the master's Waste_Notes.
//
// No I/O here — the entrypoint fetches both sides and passes plain objects in.
// Match bridge (same as reconcile): Verco eligible_properties.external_id ==
// Airtable Eligible Properties record id, THEN an exact collection-date anchor.
// A property-level match (any date) is deliberately NOT used: the Airtable notes
// are per-round, and an old round's row carries stale descriptors ("Green and
// Bulk Waste", a completed 2025 booking) that don't apply to this collection.

import { isBlank, type SourceBooking, type VercoBooking } from './reconcile'

/** The subset of a Verco booking the note backfill needs. */
export type NoteBackfillBooking = Pick<VercoBooking, 'id' | 'ref' | 'area' | 'notes' | 'propertyExternalId' | 'collectionDate'>

export type NoteFill = {
  bookingId: string
  ref: string
  area: string
  date: string | null
  note: string
  /** Airtable Booking_Ref the note was sourced from (same collection date). */
  sourceRef: string
}

export type NoteBackfillPlan = {
  fills: NoteFill[]
  /** Blank-notes bookings whose property has a master note, but only on a DIFFERENT collection date (stale prior round). Deliberately not filled — surfaced for a human to eyeball. */
  otherDateOnly: { ref: string; area: string; date: string | null; note: string; sourceDate: string | null; sourceRef: string }[]
  /** Blank-notes bookings whose property has no non-blank master note at all. */
  noSourceNote: number
  /** Bookings skipped because they already carry notes (idempotency). */
  alreadyHasNotes: number
  /** Bookings that can't be matched — no property external id. */
  noProperty: number
}

/** Pick the most recently modified row (ISO timestamps sort lexicographically). */
function latest(rows: SourceBooking[]): SourceBooking {
  return rows.reduce((best, r) => (r.modifiedAt > best.modifiedAt ? r : best))
}

/**
 * Plan the note backfill. `verco` and `source` should already be scoped to the
 * target councils. Only Verco bookings with blank notes are ever touched, and a
 * note is only carried when the master row sits on the SAME collection date, so
 * a re-run is a no-op and stale prior-round notes are never applied.
 */
export function planNoteBackfill(verco: NoteBackfillBooking[], source: SourceBooking[]): NoteBackfillPlan {
  const plan: NoteBackfillPlan = { fills: [], otherDateOnly: [], noSourceNote: 0, alreadyHasNotes: 0, noProperty: 0 }

  // Index the master rows that actually carry a note, by property.
  const notedByProp = new Map<string, SourceBooking[]>()
  for (const s of source) {
    if (isBlank(s.wasteNotes)) continue
    ;(notedByProp.get(s.propertyRecId) ?? notedByProp.set(s.propertyRecId, []).get(s.propertyRecId)!).push(s)
  }

  for (const v of verco) {
    if (!isBlank(v.notes)) {
      plan.alreadyHasNotes++
      continue
    }
    if (!v.propertyExternalId) {
      plan.noProperty++
      continue
    }
    const cands = notedByProp.get(v.propertyExternalId) ?? []
    if (cands.length === 0) {
      plan.noSourceNote++
      continue
    }

    // Same property AND same collection date — the only anchor we trust.
    const sameDate = cands.filter((s) => s.collectionDate != null && s.collectionDate === v.collectionDate)
    if (sameDate.length > 0) {
      const s = latest(sameDate)
      plan.fills.push({ bookingId: v.id, ref: v.ref, area: v.area, date: v.collectionDate, note: s.wasteNotes!.trim(), sourceRef: s.bookingRef })
      continue
    }

    // A note exists at this property, but only on a different round — don't apply it.
    const s = latest(cands)
    plan.otherDateOnly.push({ ref: v.ref, area: v.area, date: v.collectionDate, note: s.wasteNotes!.trim(), sourceDate: s.collectionDate, sourceRef: s.bookingRef })
  }

  return plan
}
