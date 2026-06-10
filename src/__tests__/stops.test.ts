import { describe, expect, it } from 'vitest'
import {
  buildOrderNo,
  buildOrderNotes,
  buildServicesSummary,
  canStopTransition,
  computeRollup,
  groupItemsByStream,
  STOP_DURATION_MINUTES,
  STREAM_PRIORITY,
  STREAM_SUFFIX,
  type StopItem,
  type StopStatus,
} from '@/lib/stops/stops'

const item = (name: string, stream: StopItem['service']['waste_stream'], qty = 1): StopItem => ({
  no_services: qty,
  service: { name, waste_stream: stream },
})

describe('buildOrderNo', () => {
  it('appends the stream suffix to the booking ref', () => {
    expect(buildOrderNo('KWN-1-AB12CD', 'general')).toBe('KWN-1-AB12CD-GEN')
    expect(buildOrderNo('KWN-1-AB12CD', 'green')).toBe('KWN-1-AB12CD-GRN')
    expect(buildOrderNo('VV-COT-XY99ZZ', 'ancillary')).toBe('VV-COT-XY99ZZ-ANC')
    expect(buildOrderNo('KWN-1-QQ00QQ', 'illegal_dumping')).toBe('KWN-1-QQ00QQ-ID')
  })

  it('every stream has a distinct suffix (orderNo uniqueness within a booking)', () => {
    const suffixes = Object.values(STREAM_SUFFIX)
    expect(new Set(suffixes).size).toBe(suffixes.length)
  })
})

describe('stream constants', () => {
  it('general runs first (H priority); all other streams are M', () => {
    expect(STREAM_PRIORITY.general).toBe('H')
    expect(STREAM_PRIORITY.green).toBe('M')
    expect(STREAM_PRIORITY.ancillary).toBe('M')
    expect(STREAM_PRIORITY.illegal_dumping).toBe('M')
  })

  it('stop duration is a positive integer of minutes', () => {
    expect(Number.isInteger(STOP_DURATION_MINUTES)).toBe(true)
    expect(STOP_DURATION_MINUTES).toBeGreaterThan(0)
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

describe('buildServicesSummary / buildOrderNotes', () => {
  it('summarises name + qty per item', () => {
    const summary = buildServicesSummary([item('General', 'general', 2), item('Green', 'green')])
    expect(summary).toEqual([
      { name: 'General', qty: 2 },
      { name: 'Green', qty: 1 },
    ])
    expect(buildOrderNotes(summary)).toBe('General x2, Green x1')
  })

  it('is deterministic regardless of input order (push EF diffs summaries)', () => {
    const a = buildServicesSummary([item('Whitegoods', 'ancillary'), item('Mattress', 'ancillary')])
    const b = buildServicesSummary([item('Mattress', 'ancillary'), item('Whitegoods', 'ancillary')])
    expect(a).toEqual(b)
    expect(a.map((s) => s.name)).toEqual(['Mattress', 'Whitegoods'])
  })

  it('empty summary renders empty notes', () => {
    expect(buildOrderNotes([])).toBe('')
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
