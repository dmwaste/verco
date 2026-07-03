// scripts/lib/reconcile.ts
//
// Pure reconciliation logic for the VV MOS/COT/PEP booking cleanup.
//
// The go-live import loaded these councils from the per-council Airtable "BR"
// intake tables (frozen original requests) instead of the consolidated
// `Bookings` master (where cancellations / reschedules / edits are made). This
// module diffs the two sides and classifies every booking so the entrypoint can
// print a review report and (Phase 2) apply the safe fixes.
//
// No I/O here — the entrypoint fetches both sides and passes plain objects in.
// Match bridge: Verco `eligible_properties.external_id` == Airtable Eligible
// Properties record id. There is no Airtable booking id on the Verco row, so we
// pair on property → date → coarse stream signature.

import { isPastCancellationCutoff } from '../../src/lib/booking/cancellation-cutoff'

/** singleSelect choices on the Airtable consolidated `Bookings` table. */
export type SourceStatus =
  | 'Booked'
  | 'Place Out Issued'
  | 'Scheduled'
  | 'Completed'
  | 'Non-Conformance'
  | 'Cancelled'

/** One row from the consolidated Airtable `Bookings` table (councils + window filtered). */
export type SourceBooking = {
  recordId: string
  bookingRef: string
  /** Airtable Eligible Properties record id — equals Verco eligible_properties.external_id. */
  propertyRecId: string
  /** YYYY-MM-DD, or null if the master row has no linked collection date. */
  collectionDate: string | null
  status: SourceStatus
  noBulk: number
  noGreen: number
  noMattress: number
  /** Master Waste_Location singleSelect (Front Verge / Side Verge / …), or null. */
  wasteLocation: string | null
  /** ISO timestamp of the master row's last modification. */
  modifiedAt: string
}

/** One Verco booking, already scoped to the MOS/COT/PEP areas. */
export type VercoBooking = {
  id: string
  ref: string
  area: string
  address: string
  /** eligible_properties.external_id (Airtable EP record id), or null for orphan bookings. */
  propertyExternalId: string | null
  /** Current booking.location — buggy imports set this to the street address. */
  location: string | null
  /** Earliest booking_item collection date, YYYY-MM-DD. */
  collectionDate: string | null
  /** Verco booking_status. */
  status: string
  /** booking.created_at ISO — the import timestamp for this row. */
  importedAt: string
  /** Bulk Waste + Whitegoods + E-Waste units (the Airtable "No_Bulk" bucket). */
  bulkCount: number
  greenCount: number
  mattressCount: number
  /** True if any collection_stop has been pushed to the routing engine. */
  isDispatched: boolean
}

export type FindingClass =
  | 'in_sync'
  | 'cancelled_in_source'
  | 'date_changed'
  | 'modified_since_import'
  | 'phantom_in_verco'
  | 'missing_in_verco'

export type Finding = {
  class: FindingClass
  verco: VercoBooking | null
  source: SourceBooking | null
  proposedAction: string
  /** null = safe to auto-apply in Phase 2. Non-null = skip & flag for manual handling. */
  blockedReason: string | null
  needsManual: boolean
}

const ACTIVE_VERCO_STATUSES = new Set(['Pending Payment', 'Submitted', 'Confirmed', 'Scheduled'])

export function isVercoActive(status: string): boolean {
  return ACTIVE_VERCO_STATUSES.has(status)
}

export function isSourceCancelled(status: SourceStatus): boolean {
  return status === 'Cancelled'
}

export function isSourceActive(status: SourceStatus): boolean {
  return status === 'Booked' || status === 'Place Out Issued' || status === 'Scheduled'
}

/** Coarse presence signature (Bulk/Green/Mattress) used to disambiguate collisions. */
function coarseSig(bulk: number, green: number, mattress: number): string {
  const sig = `${bulk > 0 ? 'B' : ''}${green > 0 ? 'G' : ''}${mattress > 0 ? 'M' : ''}`
  return sig || '-'
}
const vercoSig = (v: VercoBooking) => coarseSig(v.bulkCount, v.greenCount, v.mattressCount)
const sourceSig = (s: SourceBooking) => coarseSig(s.noBulk, s.noGreen, s.noMattress)

/** Why an otherwise-active Verco cancellation can't go through the normal path. */
function cancelBlockedReason(v: VercoBooking, now: Date): string | null {
  if (v.isDispatched || v.status === 'Scheduled') return 'dispatched'
  if (v.collectionDate && isPastCancellationCutoff(v.collectionDate, now)) return 'past_cutoff'
  return null
}

function qtyNote(v: VercoBooking, s: SourceBooking): string {
  const parts: string[] = []
  if (v.bulkCount !== s.noBulk) parts.push(`bulk ${v.bulkCount}→${s.noBulk}`)
  if (v.greenCount !== s.noGreen) parts.push(`green ${v.greenCount}→${s.noGreen}`)
  if (v.mattressCount !== s.noMattress) parts.push(`mattress ${v.mattressCount}→${s.noMattress}`)
  return parts.length ? `, qty ${parts.join('/')}` : ''
}

function classifyPair(
  v: VercoBooking,
  s: SourceBooking,
  matchKind: 'same_date' | 'diff_date',
  now: Date,
  collision: boolean,
): Finding {
  // Cancellation wins over everything — a crew must not attend a cancelled job.
  if (isSourceCancelled(s.status)) {
    const blocked = cancelBlockedReason(v, now)
    return {
      class: 'cancelled_in_source',
      verco: v,
      source: s,
      proposedAction: 'Cancel in Verco (cancelled in Airtable master)',
      blockedReason: blocked,
      needsManual: blocked != null || collision,
    }
  }

  if (matchKind === 'diff_date') {
    // A near-term date move at the same property/stream. We can't prove this is a
    // reschedule vs. a separate new booking (there's no stable Airtable booking id
    // on the Verco row), so it is ALWAYS flagged for manual review, never auto-applied.
    const reason = v.isDispatched || v.status === 'Scheduled' ? 'dispatched' : 'ambiguous_reschedule'
    return {
      class: 'date_changed',
      verco: v,
      source: s,
      proposedAction: `Possible reschedule ${v.collectionDate ?? '—'} → ${s.collectionDate ?? '—'} (verify vs. separate booking)`,
      blockedReason: reason,
      needsManual: true,
    }
  }

  // Same date, active in source: flag if the master changed after we imported.
  if (new Date(s.modifiedAt).getTime() > new Date(v.importedAt).getTime()) {
    return {
      class: 'modified_since_import',
      verco: v,
      source: s,
      proposedAction: `Manual review — master modified after import (status ${s.status}${qtyNote(v, s)})`,
      blockedReason: 'manual_review',
      needsManual: true,
    }
  }

  return { class: 'in_sync', verco: v, source: s, proposedAction: 'None', blockedReason: null, needsManual: false }
}

function phantom(v: VercoBooking): Finding {
  return {
    class: 'phantom_in_verco',
    verco: v,
    source: null,
    proposedAction: 'Report only — no matching row in Airtable master (never promoted / rejected?)',
    blockedReason: 'report_only',
    needsManual: true,
  }
}

function missing(s: SourceBooking): Finding {
  return {
    class: 'missing_in_verco',
    verco: null,
    source: s,
    proposedAction: `Create in Verco (${s.status}, ${s.collectionDate ?? '—'})`,
    blockedReason: 'create',
    needsManual: true,
  }
}

/**
 * Diff Verco bookings against the consolidated Airtable master and classify each.
 *
 * `now` is injected so cutoff decisions are deterministic in tests. Source rows
 * should already be filtered to the target councils and the import's date window.
 */
/** A same-property, same-stream move within this many days is treated as a possible reschedule. */
export const RESCHEDULE_MAX_DAYS = 21

function daysBetween(a: string, b: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y!, m! - 1, d!)
  }
  return Math.abs(t(a) - t(b)) / 86_400_000
}

export function reconcile(
  verco: VercoBooking[],
  source: SourceBooking[],
  now: Date,
  maxRescheduleDays = RESCHEDULE_MAX_DAYS,
): Finding[] {
  const findings: Finding[] = []

  const vByProp = new Map<string, VercoBooking[]>()
  const sByProp = new Map<string, SourceBooking[]>()
  const props = new Set<string>()

  for (const v of verco) {
    const key = v.propertyExternalId ?? `__noprop__${v.id}`
    ;(vByProp.get(key) ?? vByProp.set(key, []).get(key)!).push(v)
    props.add(key)
  }
  for (const s of source) {
    ;(sByProp.get(s.propertyRecId) ?? sByProp.set(s.propertyRecId, []).get(s.propertyRecId)!).push(s)
    props.add(s.propertyRecId)
  }

  for (const prop of props) {
    const vs = vByProp.get(prop) ?? []
    const ss = sByProp.get(prop) ?? []
    const collision = vs.length > 1 || ss.length > 1
    const used = new Set<number>()

    for (const v of vs) {
      let matchKind: 'same_date' | 'diff_date' = 'same_date'
      // Pass 1: same date AND same stream signature (disambiguates same-date collisions).
      let idx = ss.findIndex(
        (s, i) => !used.has(i) && s.collectionDate === v.collectionDate && sourceSig(s) === vercoSig(v),
      )
      // Pass 2: same date, any signature (a quantity/stream edit on the same date).
      if (idx < 0) idx = ss.findIndex((s, i) => !used.has(i) && s.collectionDate === v.collectionDate)
      // Pass 3: same signature, a NEARBY different date (a possible reschedule).
      // Bounded by proximity so a booking is not paired with an unrelated master
      // row (e.g. last year's completed collection at the same house).
      if (idx < 0 && v.collectionDate) {
        idx = ss.findIndex(
          (s, i) =>
            !used.has(i) &&
            sourceSig(s) === vercoSig(v) &&
            s.collectionDate != null &&
            daysBetween(v.collectionDate!, s.collectionDate) <= maxRescheduleDays,
        )
        if (idx >= 0) matchKind = 'diff_date'
      }
      // No further fallback: an unmatched booking is a genuine phantom, and an
      // unmatched active master row is genuinely missing — don't force a pairing.
      if (idx < 0) {
        findings.push(phantom(v))
        continue
      }
      used.add(idx)
      findings.push(classifyPair(v, ss[idx]!, matchKind, now, collision))
    }

    // Unmatched active source rows have no Verco booking → missing.
    ss.forEach((s, i) => {
      if (!used.has(i) && isSourceActive(s.status)) findings.push(missing(s))
    })
  }

  return findings
}

/** Group findings by class, in a stable report order. */
export const CLASS_ORDER: FindingClass[] = [
  'cancelled_in_source',
  'date_changed',
  'missing_in_verco',
  'modified_since_import',
  'phantom_in_verco',
  'in_sync',
]

export function countByClass(findings: Finding[]): Record<FindingClass, number> {
  const out = Object.fromEntries(CLASS_ORDER.map((c) => [c, 0])) as Record<FindingClass, number>
  for (const f of findings) out[f.class]++
  return out
}

// ─── Action plan (Phase 2) ─────────────────────────────────────────────────────
//
// Turns findings into concrete writes, per Dan's directives (03/07/2026):
//   • cancelled in master        → cancel (only the non-blocked ones)
//   • master Completed           → set Verco Completed   (legal only from Scheduled)
//   • master Non-Conformance     → set Verco Non-conformance (legal only from Scheduled)
//   • master Place Out Issued    → SKIP: mapping to Scheduled crosses Red Line #5
//                                  (the cron owns Confirmed→Scheduled + stop generation)
//   • reschedule                 → update date ONLY when both old and new dates are future
//                                  and the booking is not already dispatched
//   • location == street address → set to the master Waste_Location
//   • phantom (keep) / missing (ignore) → no writes

export type Action =
  | { kind: 'cancel'; bookingId: string; ref: string; masterRef: string }
  | { kind: 'status'; bookingId: string; ref: string; to: 'Completed' | 'Non-conformance' }
  | { kind: 'reschedule'; bookingId: string; ref: string; from: string; to: string }
  | { kind: 'location'; bookingId: string; ref: string; to: string }

export type ActionPlan = {
  actions: Action[]
  skipped: {
    placeOutToScheduled: number // Red Line #5 — left for the cron
    reactivateCancelled: number // master active but Verco already Cancelled (terminal)
    dispatchedReschedule: number // date move on an already-dispatched booking
    phantomNeedsLocation: number // phantom with a bad location we can't source from the master
  }
}

/**
 * Collapse a verbose master Waste_Location to Verco's short form.
 * "Driveway (Verge side of letterbox)" → "Driveway";
 * "Front Verge; Side Verge; Laneway (If no other option applicable)" → "Front Verge; Side Verge; Laneway".
 * Combined selections are split on ';', mapped per segment, de-duped, and rejoined.
 */
export function normaliseWasteLocation(raw: string): string {
  const parts = raw
    .split(';')
    .map((seg) => {
      const l = seg.trim().toLowerCase()
      if (l.startsWith('front verge')) return 'Front Verge'
      if (l.startsWith('side verge')) return 'Side Verge'
      if (l.startsWith('rear')) return 'Rear Verge'
      if (l.startsWith('driveway')) return 'Driveway'
      if (l.startsWith('laneway')) return 'Laneway'
      if (l.startsWith('other')) return 'Other'
      return seg.trim()
    })
    .filter(Boolean)
  return [...new Set(parts)].join('; ')
}

export function buildActionPlan(findings: Finding[], today: string): ActionPlan {
  const actions: Action[] = []
  const skipped = { placeOutToScheduled: 0, reactivateCancelled: 0, dispatchedReschedule: 0, phantomNeedsLocation: 0 }
  const locationIsWrong = (v: VercoBooking) => !!v.location && !!v.address && v.location === v.address

  for (const f of findings) {
    const v = f.verco
    const s = f.source

    if (f.class === 'cancelled_in_source' && v && s && !f.needsManual && isVercoActive(v.status)) {
      // isVercoActive guard keeps this idempotent — a re-run won't re-cancel a
      // booking already Cancelled (which the state-machine trigger would reject).
      actions.push({ kind: 'cancel', bookingId: v.id, ref: v.ref, masterRef: s.bookingRef })
      continue // don't also fix the location of a booking we're cancelling
    }

    if (f.class === 'modified_since_import' && v && s) {
      if (v.status === 'Cancelled') skipped.reactivateCancelled++
      else if (s.status === 'Completed' && v.status === 'Scheduled')
        actions.push({ kind: 'status', bookingId: v.id, ref: v.ref, to: 'Completed' })
      else if (s.status === 'Non-Conformance' && v.status === 'Scheduled')
        actions.push({ kind: 'status', bookingId: v.id, ref: v.ref, to: 'Non-conformance' })
      else if (s.status === 'Place Out Issued' && v.status === 'Confirmed') skipped.placeOutToScheduled++
    }

    if (f.class === 'date_changed' && v && s && v.collectionDate && s.collectionDate) {
      if (v.collectionDate > today && s.collectionDate > today) {
        if (v.isDispatched || v.status === 'Scheduled') skipped.dispatchedReschedule++
        else actions.push({ kind: 'reschedule', bookingId: v.id, ref: v.ref, from: v.collectionDate, to: s.collectionDate })
      }
    }

    // Location fix — any matched, non-cancelled booking whose location is the street address.
    if (v && locationIsWrong(v) && v.status !== 'Cancelled' && f.class !== 'cancelled_in_source') {
      if (s?.wasteLocation) actions.push({ kind: 'location', bookingId: v.id, ref: v.ref, to: normaliseWasteLocation(s.wasteLocation) })
      else if (!s) skipped.phantomNeedsLocation++
    }
  }

  return { actions, skipped }
}
