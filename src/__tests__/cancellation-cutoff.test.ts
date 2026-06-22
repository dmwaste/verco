import { describe, it, expect } from 'vitest'

import {
  cancellationCutoff,
  isPastCancellationCutoff,
} from '@/lib/booking/cancellation-cutoff'

describe('cancellationCutoff — 3:30pm AWST the day before collection (WS-G)', () => {
  it('is 07:30 UTC the day before (= 3:30pm AWST, no DST in WA)', () => {
    // Collection 2026-06-22 → cutoff 2026-06-21 15:30 AWST = 2026-06-21 07:30 UTC.
    expect(cancellationCutoff('2026-06-22').toISOString()).toBe(
      '2026-06-21T07:30:00.000Z'
    )
  })

  it('handles month rollover (collection on the 1st)', () => {
    expect(cancellationCutoff('2026-07-01').toISOString()).toBe(
      '2026-06-30T07:30:00.000Z'
    )
  })

  it('matches the DB trigger formula ((date - 1 day)::timestamptz + 7h30m, UTC server)', () => {
    expect(cancellationCutoff('2026-01-01').toISOString()).toBe(
      '2025-12-31T07:30:00.000Z'
    )
  })
})

describe('isPastCancellationCutoff — runtime-timezone independent', () => {
  it('allows one second before the cutoff', () => {
    expect(
      isPastCancellationCutoff('2026-06-22', new Date('2026-06-21T07:29:59.000Z'))
    ).toBe(false)
  })

  it('blocks at/after the cutoff', () => {
    expect(
      isPastCancellationCutoff('2026-06-22', new Date('2026-06-21T07:30:00.000Z'))
    ).toBe(true)
  })

  it('a Perth-evening "now" two days before still allows (the bug the old setHours math got wrong)', () => {
    // 2026-06-20 21:00 AWST = 2026-06-20 13:00 UTC — well before the 07:30 UTC cutoff.
    expect(
      isPastCancellationCutoff('2026-06-22', new Date('2026-06-20T13:00:00.000Z'))
    ).toBe(false)
  })
})
