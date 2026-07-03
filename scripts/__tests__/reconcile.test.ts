import { describe, it, expect } from 'vitest'
import {
  reconcile,
  countByClass,
  buildActionPlan,
  normaliseWasteLocation,
  isSourceActive,
  isSourceCancelled,
  isVercoActive,
  type VercoBooking,
  type SourceBooking,
} from '../lib/reconcile'

const NOW = new Date('2026-07-03T06:00:00Z')

function verco(overrides: Partial<VercoBooking> = {}): VercoBooking {
  return {
    id: 'v1',
    ref: 'COT-100',
    area: 'COT',
    address: '1 Test St',
    propertyExternalId: 'recProp1',
    location: '1 Test St', // buggy default: location == address
    collectionDate: '2026-07-08', // clearly future (cutoff 2026-07-07 07:30Z)
    status: 'Confirmed',
    importedAt: '2026-07-01T00:00:00Z',
    bulkCount: 1,
    greenCount: 0,
    mattressCount: 0,
    isDispatched: false,
    ...overrides,
  }
}

function source(overrides: Partial<SourceBooking> = {}): SourceBooking {
  return {
    recordId: 'recBk1',
    bookingRef: 'COT-57000',
    propertyRecId: 'recProp1',
    collectionDate: '2026-07-08',
    status: 'Booked',
    noBulk: 1,
    noGreen: 0,
    noMattress: 0,
    wasteLocation: 'Front Verge',
    modifiedAt: '2026-06-25T00:00:00Z', // before import → unchanged
    ...overrides,
  }
}

const TODAY = '2026-07-03'

describe('status predicates', () => {
  it('maps source active/cancelled correctly', () => {
    expect(isSourceActive('Booked')).toBe(true)
    expect(isSourceActive('Place Out Issued')).toBe(true)
    expect(isSourceActive('Scheduled')).toBe(true)
    expect(isSourceActive('Cancelled')).toBe(false)
    expect(isSourceActive('Completed')).toBe(false)
    expect(isSourceCancelled('Cancelled')).toBe(true)
    expect(isSourceCancelled('Booked')).toBe(false)
  })

  it('treats pre-collection Verco statuses as active', () => {
    expect(isVercoActive('Confirmed')).toBe(true)
    expect(isVercoActive('Scheduled')).toBe(true)
    expect(isVercoActive('Cancelled')).toBe(false)
    expect(isVercoActive('Completed')).toBe(false)
  })
})

describe('reconcile — matched pairs', () => {
  it('in_sync when same date and master untouched since import', () => {
    const f = reconcile([verco()], [source()], NOW)
    expect(f).toHaveLength(1)
    expect(f[0]!.class).toBe('in_sync')
    expect(f[0]!.blockedReason).toBeNull()
  })

  it('cancelled_in_source is auto-appliable when future + not dispatched', () => {
    const f = reconcile([verco()], [source({ status: 'Cancelled' })], NOW)
    expect(f[0]!.class).toBe('cancelled_in_source')
    expect(f[0]!.blockedReason).toBeNull()
    expect(f[0]!.needsManual).toBe(false)
  })

  it('cancelled_in_source is blocked past the cutoff', () => {
    // collection already 2026-07-01 → cutoff 2026-06-30 07:30Z → past
    const f = reconcile(
      [verco({ collectionDate: '2026-07-01' })],
      [source({ collectionDate: '2026-07-01', status: 'Cancelled' })],
      NOW,
    )
    expect(f[0]!.class).toBe('cancelled_in_source')
    expect(f[0]!.blockedReason).toBe('past_cutoff')
    expect(f[0]!.needsManual).toBe(true)
  })

  it('cancelled_in_source is blocked when already dispatched/Scheduled', () => {
    const f = reconcile(
      [verco({ status: 'Scheduled', isDispatched: true })],
      [source({ status: 'Cancelled' })],
      NOW,
    )
    expect(f[0]!.blockedReason).toBe('dispatched')
  })

  it('date_changed for a nearby move is always flagged manual (never auto-applied)', () => {
    const f = reconcile([verco()], [source({ collectionDate: '2026-07-15' })], NOW)
    expect(f[0]!.class).toBe('date_changed')
    expect(f[0]!.blockedReason).toBe('ambiguous_reschedule')
    expect(f[0]!.needsManual).toBe(true)
    expect(f[0]!.proposedAction).toContain('2026-07-08 → 2026-07-15')
  })

  it('date_changed reason is dispatched when the booking is already out', () => {
    const f = reconcile(
      [verco({ status: 'Scheduled' })],
      [source({ collectionDate: '2026-07-15' })],
      NOW,
    )
    expect(f[0]!.class).toBe('date_changed')
    expect(f[0]!.blockedReason).toBe('dispatched')
  })

  it('a far date move is NOT a reschedule — splits into phantom + missing', () => {
    // Same property + stream but 8 weeks apart → almost certainly two separate
    // bookings, not a reschedule. Must not pair (that would risk moving a real job).
    const f = reconcile([verco({ collectionDate: '2026-07-08' })], [source({ collectionDate: '2026-09-01' })], NOW)
    expect(f.map((x) => x.class).sort()).toEqual(['missing_in_verco', 'phantom_in_verco'])
  })

  it('modified_since_import when same date but master touched after import', () => {
    const f = reconcile([verco()], [source({ modifiedAt: '2026-07-03T01:00:00Z' })], NOW)
    expect(f[0]!.class).toBe('modified_since_import')
    expect(f[0]!.needsManual).toBe(true)
  })

  it('cancellation takes precedence over a modified-since-import flag', () => {
    const f = reconcile(
      [verco()],
      [source({ status: 'Cancelled', modifiedAt: '2026-07-03T01:00:00Z' })],
      NOW,
    )
    expect(f[0]!.class).toBe('cancelled_in_source')
  })
})

describe('reconcile — unmatched rows', () => {
  it('missing_in_verco for an active master row with no Verco booking', () => {
    const f = reconcile([], [source({ propertyRecId: 'recOnlyInMaster' })], NOW)
    expect(f[0]!.class).toBe('missing_in_verco')
  })

  it('a cancelled master row absent from Verco needs no action', () => {
    const f = reconcile([], [source({ propertyRecId: 'recGone', status: 'Cancelled' })], NOW)
    expect(f).toHaveLength(0)
  })

  it('phantom_in_verco for a Verco booking with no master row', () => {
    const f = reconcile([verco({ propertyExternalId: 'recOnlyInVerco' })], [], NOW)
    expect(f[0]!.class).toBe('phantom_in_verco')
  })
})

describe('reconcile — collision disambiguation', () => {
  it('pairs two same-date bookings at one property by stream signature', () => {
    const vGreen = verco({ id: 'vG', ref: 'COT-1', bulkCount: 0, greenCount: 2 })
    const vBulk = verco({ id: 'vB', ref: 'COT-2', bulkCount: 1, greenCount: 0 })
    // master rows arrive in the opposite order → must match on signature, not position.
    // The green one is cancelled to exercise an actionable class under collision.
    const sBulk = source({ recordId: 'sB', noBulk: 1, noGreen: 0 })
    const sGreen = source({ recordId: 'sG', noBulk: 0, noGreen: 2, status: 'Cancelled' })

    const f = reconcile([vGreen, vBulk], [sBulk, sGreen], NOW)
    expect(f).toHaveLength(2)
    const byRef = Object.fromEntries(f.map((x) => [x.verco!.ref, x]))
    expect(byRef['COT-1']!.source!.recordId).toBe('sG') // green ↔ green
    expect(byRef['COT-2']!.source!.recordId).toBe('sB') // bulk ↔ bulk
    // The cancel is real, but under a collision it's flagged for manual review rather than auto-applied.
    expect(byRef['COT-1']!.class).toBe('cancelled_in_source')
    expect(byRef['COT-1']!.needsManual).toBe(true)
    // The cleanly-matched bulk row is in sync and needs nothing.
    expect(byRef['COT-2']!.class).toBe('in_sync')
    expect(byRef['COT-2']!.needsManual).toBe(false)
  })
})

describe('countByClass', () => {
  it('tallies every class in the report', () => {
    const findings = reconcile(
      [
        verco({ id: 'a', propertyExternalId: 'p1' }),
        verco({ id: 'b', propertyExternalId: 'p2' }),
      ],
      [
        source({ propertyRecId: 'p1', status: 'Cancelled' }),
        source({ propertyRecId: 'p3' }), // missing in verco
      ],
      NOW,
    )
    const counts = countByClass(findings)
    expect(counts.cancelled_in_source).toBe(1)
    expect(counts.phantom_in_verco).toBe(1) // p2 has no master row
    expect(counts.missing_in_verco).toBe(1) // p3
  })
})

describe('buildActionPlan', () => {
  const plan = (v: VercoBooking[], s: SourceBooking[]) => buildActionPlan(reconcile(v, s, NOW), TODAY)

  it('plans a cancel and does not also fix the location of a cancelled booking', () => {
    const p = plan([verco()], [source({ status: 'Cancelled' })])
    expect(p.actions.map((a) => a.kind)).toEqual(['cancel'])
  })

  it('is idempotent — does not re-cancel a booking already Cancelled', () => {
    const p = plan([verco({ status: 'Cancelled' })], [source({ status: 'Cancelled' })])
    expect(p.actions.some((a) => a.kind === 'cancel')).toBe(false)
  })

  it('maps master Completed → Verco Completed only from Scheduled', () => {
    const p = plan([verco({ status: 'Scheduled' })], [source({ status: 'Completed', modifiedAt: '2026-07-02T00:00:00Z' })])
    expect(p.actions.some((a) => a.kind === 'status' && a.to === 'Completed')).toBe(true)
  })

  it('maps master Non-Conformance → Verco Non-conformance from Scheduled', () => {
    const p = plan([verco({ status: 'Scheduled' })], [source({ status: 'Non-Conformance', modifiedAt: '2026-07-02T00:00:00Z' })])
    expect(p.actions.some((a) => a.kind === 'status' && a.to === 'Non-conformance')).toBe(true)
  })

  it('refuses to force Place Out Issued → Scheduled (Red Line #5), but still fixes its location', () => {
    const p = plan([verco({ status: 'Confirmed' })], [source({ status: 'Place Out Issued', modifiedAt: '2026-07-02T00:00:00Z' })])
    expect(p.skipped.placeOutToScheduled).toBe(1)
    expect(p.actions.some((a) => a.kind === 'status')).toBe(false)
    expect(p.actions.some((a) => a.kind === 'location')).toBe(true)
  })

  it('reschedules only future→future, undispatched', () => {
    const ok = plan([verco()], [source({ collectionDate: '2026-07-15' })])
    expect(ok.actions.some((a) => a.kind === 'reschedule')).toBe(true)

    const disp = plan([verco({ isDispatched: true })], [source({ collectionDate: '2026-07-15' })])
    expect(disp.actions.some((a) => a.kind === 'reschedule')).toBe(false)
    expect(disp.skipped.dispatchedReschedule).toBe(1)
  })

  it('fixes location when it equals the street address, and leaves a correct location alone', () => {
    const wrong = plan([verco()], [source()]) // location default == address
    expect(wrong.actions.find((a) => a.kind === 'location')).toMatchObject({ to: 'Front Verge' })

    const correct = plan([verco({ location: 'Side Verge' })], [source()])
    expect(correct.actions.some((a) => a.kind === 'location')).toBe(false)
  })

  it('normalises the master location to a short form when fixing', () => {
    const p = plan([verco()], [source({ wasteLocation: 'Driveway (Verge side of letterbox)' })])
    expect(p.actions.find((a) => a.kind === 'location')).toMatchObject({ to: 'Driveway' })
  })

  it('cannot source a location for a phantom (no master row)', () => {
    const p = plan([verco({ propertyExternalId: 'recOrphan' })], [])
    expect(p.skipped.phantomNeedsLocation).toBe(1)
    expect(p.actions).toHaveLength(0)
  })
})

describe('normaliseWasteLocation', () => {
  it('collapses verbose single values', () => {
    expect(normaliseWasteLocation('Driveway (Verge side of letterbox)')).toBe('Driveway')
    expect(normaliseWasteLocation('Laneway (If no other option applicable)')).toBe('Laneway')
    expect(normaliseWasteLocation('Rear verge')).toBe('Rear Verge')
    expect(normaliseWasteLocation('Other (Subject to WMRC authorisation - contact vergevalet@wmrc.wa.gov.au)')).toBe('Other')
  })

  it('splits, maps and de-dupes combined selections', () => {
    expect(normaliseWasteLocation('Front Verge; Side Verge; Driveway (Verge side of letterbox)')).toBe('Front Verge; Side Verge; Driveway')
    expect(normaliseWasteLocation('Driveway (Verge side of letterbox); Driveway')).toBe('Driveway')
  })
})
