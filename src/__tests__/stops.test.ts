import { describe, expect, it } from 'vitest'
import {
  buildOrderNo,
  buildOrderNotes,
  buildServicesSummary,
  canStopTransition,
  computeRollup,
  groupItemsByStream,
  partitionPushResults,
  STOP_DURATION_MINUTES,
  STREAM_PRIORITY,
  STREAM_SUFFIX,
  servicesSummariesEqual,
  shouldCancelOrphanStop,
  stopItemKey,
  vehicleFeaturesForStream,
  wasteLocationOrNull,
  type ServiceSummaryEntry,
  type StopItem,
  type StopStatus,
  type WasteStream,
} from '@/lib/stops/stops'

const item = (name: string, stream: StopItem['service']['waste_stream'], qty = 1): StopItem => ({
  no_services: qty,
  service: { name, waste_stream: stream },
})

describe('buildOrderNo', () => {
  it('appends the stream suffix to the booking ref', () => {
    expect(buildOrderNo('KWN-1-AB12CD', 'general')).toBe('KWN-1-AB12CD-B')
    expect(buildOrderNo('KWN-1-AB12CD', 'green')).toBe('KWN-1-AB12CD-G')
    expect(buildOrderNo('VV-COT-XY99ZZ', 'ancillary')).toBe('VV-COT-XY99ZZ-A')
    expect(buildOrderNo('KWN-1-QQ00QQ', 'illegal_dumping')).toBe('KWN-1-QQ00QQ-ID')
  })

  it('every stream has a distinct suffix (orderNo uniqueness within a booking)', () => {
    const suffixes = Object.values(STREAM_SUFFIX)
    expect(new Set(suffixes).size).toBe(suffixes.length)
  })
})

describe('stream constants', () => {
  it('green runs first (H priority); all other streams are M', () => {
    expect(STREAM_PRIORITY.green).toBe('H')
    expect(STREAM_PRIORITY.general).toBe('M')
    expect(STREAM_PRIORITY.ancillary).toBe('M')
    expect(STREAM_PRIORITY.illegal_dumping).toBe('M')
  })

  it('stop duration is a positive integer of minutes', () => {
    expect(Number.isInteger(STOP_DURATION_MINUTES)).toBe(true)
    expect(STOP_DURATION_MINUTES).toBeGreaterThan(0)
  })
})

describe('vehicleFeaturesForStream — OptimoRoute routing constraint', () => {
  it('maps each waste stream to its account vehicle-feature code', () => {
    expect(vehicleFeaturesForStream('general')).toEqual(['BLK'])
    expect(vehicleFeaturesForStream('green')).toEqual(['GRN'])
    expect(vehicleFeaturesForStream('ancillary')).toEqual(['ANC'])
  })

  it('general maps to the BLK feature, distinct from its -B order suffix', () => {
    expect(vehicleFeaturesForStream('general')).toEqual(['BLK'])
    expect(STREAM_SUFFIX.general).toBe('B')
  })

  it('illegal_dumping is bulk-truck work — also requires BLK', () => {
    expect(vehicleFeaturesForStream('illegal_dumping')).toEqual(['BLK'])
  })
})

describe('wasteLocationOrNull — placement vs overloaded booking.location', () => {
  it('keeps recognised on-property placements', () => {
    expect(wasteLocationOrNull('Front Verge')).toBe('Front Verge')
    expect(wasteLocationOrNull('Side Verge')).toBe('Side Verge')
    expect(wasteLocationOrNull('Driveway')).toBe('Driveway')
    expect(wasteLocationOrNull('Other')).toBe('Other')
  })

  it('drops an address — booking.location is overloaded and mostly holds the street address', () => {
    expect(wasteLocationOrNull('4 William Street COTTESLOE WA 6011')).toBeNull()
    expect(wasteLocationOrNull('35A Fennager Way CALISTA WESTERN AUSTRALIA 6167')).toBeNull()
  })

  it('handles null and blank', () => {
    expect(wasteLocationOrNull(null)).toBeNull()
    expect(wasteLocationOrNull('')).toBeNull()
    expect(wasteLocationOrNull('   ')).toBeNull()
  })

  it('trims surrounding whitespace before matching', () => {
    expect(wasteLocationOrNull('  Front Verge  ')).toBe('Front Verge')
  })
})

describe('groupItemsByStream', () => {
  it('splits a mixed booking into one group per stream', () => {
    const groups = groupItemsByStream([
      item('General', 'general', 2),
      item('Green', 'green'),
      item('Mattress', 'ancillary'),
      item('E-Waste', 'ancillary'),
    ])
    expect([...groups.keys()].sort()).toEqual(['ancillary', 'general', 'green'])
    expect(groups.get('ancillary')).toHaveLength(2)
    expect(groups.get('general')).toHaveLength(1)
  })

  it('returns an empty map for no items', () => {
    expect(groupItemsByStream([]).size).toBe(0)
  })
})

describe('buildServicesSummary', () => {
  it('summarises name + qty per item', () => {
    const summary = buildServicesSummary([item('General', 'general', 2), item('Green', 'green')])
    expect(summary).toEqual([
      { name: 'General', qty: 2 },
      { name: 'Green', qty: 1 },
    ])
  })

  it('is deterministic regardless of input order (push EF diffs summaries)', () => {
    const a = buildServicesSummary([item('Whitegoods', 'ancillary'), item('Mattress', 'ancillary')])
    const b = buildServicesSummary([item('Mattress', 'ancillary'), item('Whitegoods', 'ancillary')])
    expect(a).toEqual(b)
    expect(a.map((s) => s.name)).toEqual(['Mattress', 'Whitegoods'])
  })
})

describe('servicesSummariesEqual', () => {
  it('treats jsonb key-reordered entries as equal (nightly refresh-storm bug, 13/07/2026)', () => {
    // Postgres jsonb returns {"qty": …, "name": …} (shorter key first) while the
    // EF builds {name, qty} — a JSON.stringify comparison is unequal for
    // identical content, so payloadDiffers refreshed + re-pushed every pending
    // stop every night until the run outgrew its invocation window.
    const stored: ServiceSummaryEntry[] = [{ qty: 1, name: 'Bulk Waste' }]
    const desired: ServiceSummaryEntry[] = [{ name: 'Bulk Waste', qty: 1 }]
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(desired))
    expect(servicesSummariesEqual(stored, desired)).toBe(true)
  })

  it('is entry-order-insensitive', () => {
    expect(
      servicesSummariesEqual(
        [
          { name: 'Mattress', qty: 1 },
          { name: 'Whitegoods', qty: 2 },
        ],
        [
          { name: 'Whitegoods', qty: 2 },
          { name: 'Mattress', qty: 1 },
        ],
      ),
    ).toBe(true)
  })

  it('detects real changes', () => {
    const base: ServiceSummaryEntry[] = [{ name: 'Bulk Waste', qty: 1 }]
    expect(servicesSummariesEqual(base, [{ name: 'Bulk Waste', qty: 2 }])).toBe(false)
    expect(servicesSummariesEqual(base, [{ name: 'Green Waste', qty: 1 }])).toBe(false)
    expect(servicesSummariesEqual(base, [])).toBe(false)
    expect(
      servicesSummariesEqual(base, [
        { name: 'Bulk Waste', qty: 1 },
        { name: 'E-Waste', qty: 1 },
      ]),
    ).toBe(false)
  })

  it('treats two empty summaries as equal', () => {
    expect(servicesSummariesEqual([], [])).toBe(true)
  })

  it('treats malformed stored entries as changed instead of throwing', () => {
    // services_summary is unconstrained jsonb — incident-time manual row
    // surgery can leave shapes the type signature promises away. A throw here
    // escapes the per-stop loop and aborts the entire nightly push.
    const desired: ServiceSummaryEntry[] = [{ name: 'Bulk Waste', qty: 1 }]
    const poisoned = [null] as unknown as ServiceSummaryEntry[]
    expect(servicesSummariesEqual(poisoned, desired)).toBe(false)
  })

  it('treats a non-array stored value as changed instead of throwing', () => {
    // jsonb string scalar of length 1 passes the length guard but has no .map
    const stored = 'x' as unknown as ServiceSummaryEntry[]
    const desired: ServiceSummaryEntry[] = [{ name: 'Bulk Waste', qty: 1 }]
    expect(servicesSummariesEqual(stored, desired)).toBe(false)
  })
})

describe('buildOrderNotes — structured OptimoRoute notes block', () => {
  const summary = [
    { name: 'General', qty: 2 },
    { name: 'Green', qty: 1 },
  ]

  it('labels the services line', () => {
    expect(buildOrderNotes(summary)).toBe('Services: General x2, Green x1')
  })

  it('stacks Services / Location / Notes as labelled lines', () => {
    expect(buildOrderNotes(summary, 'Front Verge', 'Side street of the property')).toBe(
      'Services: General x2, Green x1\nLocation: Front Verge\nNotes: Side street of the property',
    )
  })

  it('omits the Location and Notes lines when blank', () => {
    expect(buildOrderNotes(summary, null, null)).toBe('Services: General x2, Green x1')
    expect(buildOrderNotes(summary, '', '   ')).toBe('Services: General x2, Green x1')
  })

  it('omits the Services line when the summary is empty', () => {
    expect(buildOrderNotes([], 'Driveway', 'Behind the gate')).toBe(
      'Location: Driveway\nNotes: Behind the gate',
    )
  })

  it('trims surrounding whitespace on location and notes', () => {
    expect(buildOrderNotes([], '  Side Verge  ', '  leave at kerb  ')).toBe(
      'Location: Side Verge\nNotes: leave at kerb',
    )
  })

  it('renders empty notes for a fully empty stop', () => {
    expect(buildOrderNotes([])).toBe('')
    expect(buildOrderNotes([], null, null)).toBe('')
  })
})

describe('canStopTransition — parity with enforce_stop_state_transition', () => {
  const STATUSES: StopStatus[] = [
    'Pending',
    'Completed',
    'Non-conformance',
    'Nothing Presented',
    'Cancelled',
  ]

  it('Pending reaches every other status', () => {
    for (const to of STATUSES.filter((s) => s !== 'Pending')) {
      expect(canStopTransition('Pending', to)).toBe(true)
    }
  })

  it('self-transitions are not transitions', () => {
    for (const s of STATUSES) {
      expect(canStopTransition(s, s)).toBe(false)
      expect(canStopTransition(s, s, { privileged: true })).toBe(false)
    }
  })

  it('terminal states are immutable for normal writers', () => {
    for (const from of STATUSES.filter((s) => s !== 'Pending')) {
      for (const to of STATUSES.filter((s) => s !== from)) {
        expect(canStopTransition(from, to)).toBe(false)
      }
    }
  })

  it('privileged writers may revive Cancelled → Pending, and nothing else', () => {
    expect(canStopTransition('Cancelled', 'Pending', { privileged: true })).toBe(true)
    for (const from of ['Completed', 'Non-conformance', 'Nothing Presented'] as StopStatus[]) {
      for (const to of STATUSES.filter((s) => s !== from)) {
        expect(canStopTransition(from, to, { privileged: true })).toBe(false)
      }
    }
    expect(canStopTransition('Cancelled', 'Completed', { privileged: true })).toBe(false)
  })
})

describe('shouldCancelOrphanStop — Pass-1 orphan reconciliation', () => {
  const base = {
    stopStream: 'green' as WasteStream,
    stopDateId: 'd1',
    desiredStreamsForBooking: null as readonly WasteStream[] | null,
    bookingLive: true,
    currentItemKeys: new Set<string>(),
  }

  it('cancels when the stream is gone from an in-window booking', () => {
    expect(shouldCancelOrphanStop({ ...base, desiredStreamsForBooking: ['general'] })).toBe(true)
  })

  it('keeps when the stream is still present in-window', () => {
    expect(
      shouldCancelOrphanStop({ ...base, desiredStreamsForBooking: ['general', 'green'] }),
    ).toBe(false)
  })

  it('cancels when the booking is no longer live', () => {
    expect(shouldCancelOrphanStop({ ...base, bookingLive: false })).toBe(true)
  })

  it('cancels a live booking rescheduled off this date+stream (the phantom-order bug)', () => {
    // green stop on d1, but the booking's green item now sits on d2 (a not-yet-locked date)
    expect(
      shouldCancelOrphanStop({ ...base, currentItemKeys: new Set([stopItemKey('d2', 'green')]) }),
    ).toBe(true)
  })

  it('keeps a live booking that still has an item on this date+stream', () => {
    expect(
      shouldCancelOrphanStop({ ...base, currentItemKeys: new Set([stopItemKey('d1', 'green')]) }),
    ).toBe(false)
  })

  it('stopItemKey composes date and stream unambiguously', () => {
    expect(stopItemKey('abc', 'ancillary')).toBe('abc:ancillary')
  })
})

describe('computeRollup — parity with rollup_booking_status_from_stops', () => {
  const roll = (...statuses: StopStatus[]) => computeRollup(statuses)

  it('null while any stop is Pending', () => {
    expect(roll('Pending')).toBeNull()
    expect(roll('Completed', 'Pending')).toBeNull()
    expect(roll('Non-conformance', 'Pending', 'Completed')).toBeNull()
  })

  it('null for no stops and for all-Cancelled (booking-cancel path owns it)', () => {
    expect(roll()).toBeNull()
    expect(roll('Cancelled')).toBeNull()
    expect(roll('Cancelled', 'Cancelled')).toBeNull()
  })

  it('exception wins: any NCN beats NP beats Completed', () => {
    expect(roll('Completed', 'Non-conformance')).toBe('Non-conformance')
    expect(roll('Nothing Presented', 'Non-conformance', 'Completed')).toBe('Non-conformance')
    expect(roll('Completed', 'Nothing Presented')).toBe('Nothing Presented')
    expect(roll('Completed', 'Completed')).toBe('Completed')
  })

  it('cancelled stops are excluded from the rollup, not counted as outcomes', () => {
    expect(roll('Completed', 'Cancelled')).toBe('Completed')
    expect(roll('Cancelled', 'Nothing Presented')).toBe('Nothing Presented')
    expect(roll('Cancelled', 'Non-conformance', 'Completed')).toBe('Non-conformance')
  })
})

describe('partitionPushResults — positional match of OR results to stops', () => {
  const stop = (id: string, ref: string) => ({ id, external_order_ref: ref })

  it('routes successes to okIds and failures with their per-order message', () => {
    const { okIds, failures } = partitionPushResults(
      [stop('s1', 'KWN-1-A'), stop('s2', 'KWN-1-B'), stop('s3', 'KWN-1-G')],
      [{ success: true }, { success: false, error: 'rejected' }, { success: true }],
    )
    expect(okIds).toEqual(['s1', 's3'])
    expect(failures).toEqual([{ id: 's2', orderRef: 'KWN-1-B', error: 'rejected' }])
  })

  it('a missing result (short/dropped results array) is a failure, never a silent push', () => {
    // The bug this guards: if OR returns fewer results than orders sent, the
    // tail stops must NOT be stamped pushed_at — they were never confirmed.
    const { okIds, failures } = partitionPushResults(
      [stop('s1', 'KWN-1-A'), stop('s2', 'KWN-1-B')],
      [{ success: true }], // s2 has no matching result
    )
    expect(okIds).toEqual(['s1'])
    expect(failures).toEqual([{ id: 's2', orderRef: 'KWN-1-B', error: 'no result returned' }])
  })

  it('defaults the message when a failure result carries no error string', () => {
    const { failures } = partitionPushResults(
      [stop('s1', 'KWN-1-A')],
      [{ success: false }],
    )
    expect(failures).toEqual([{ id: 's1', orderRef: 'KWN-1-A', error: 'no result returned' }])
  })

  it('handles all-success and all-fail cleanly', () => {
    expect(
      partitionPushResults([stop('s1', 'r1')], [{ success: true }]),
    ).toEqual({ okIds: ['s1'], failures: [] })
    expect(
      partitionPushResults([stop('s1', 'r1')], [{ success: false, error: 'HTTP 500' }]),
    ).toEqual({ okIds: [], failures: [{ id: 's1', orderRef: 'r1', error: 'HTTP 500' }] })
  })

  it('is empty-safe', () => {
    expect(partitionPushResults([], [])).toEqual({ okIds: [], failures: [] })
  })
})
