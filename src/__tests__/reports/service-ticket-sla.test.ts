import { describe, it, expect } from 'vitest'
import {
  computeServiceTicketSla,
  RESPONSE_TARGET_WD,
  RESOLUTION_TARGET_DAYS,
  SERVICE_TICKET_SLA_LOW_N,
  type ServiceTicketRow,
} from '@/lib/reports/service-ticket-sla'

/**
 * SR — Service Ticket SLA (spec §3.4). Two independent sub-SLAs on one card:
 *   - First response: createdAt → firstResponseAt within 3 WORKING days.
 *   - Resolution:     createdAt → resolvedAt within 30 CALENDAR days.
 *
 * Inputs match the Phase-3 consumer fold (plan Task 19): each ticket carries
 * `createdAtAwst` (bare AWST YYYY-MM-DD), `firstResponseAtAwst` (bare AWST date
 * or null) and `resolvedAtUtc` (raw UTC timestamp = COALESCE(resolved_at,
 * closed_at), or null). `waHolidays` is the shared WA-holiday Set.
 *
 * Calendar anchors (AWST = UTC+8, no DST):
 *   2026-06-15 Mon · 16 Tue · 17 Wed · 18 Thu · 19 Fri · 20 Sat · 21 Sun · 22 Mon
 *   New Year's Day 2026-01-01 (Thu) is a WA holiday.
 */

function ticket(p: Partial<ServiceTicketRow>): ServiceTicketRow {
  return {
    createdAtAwst: '2026-06-15',
    firstResponseAtAwst: null,
    resolvedAtUtc: null,
    ...p,
  }
}

describe('exported constants', () => {
  it('exposes the tunable target + low-n constants from the spec', () => {
    expect(RESPONSE_TARGET_WD).toBe(3)
    expect(RESOLUTION_TARGET_DAYS).toBe(30)
    expect(SERVICE_TICKET_SLA_LOW_N).toBe(5)
  })
})

describe('computeServiceTicketSla — empty dataset', () => {
  it('no tickets → both sub-metrics empty, pct null', () => {
    const r = computeServiceTicketSla({ tickets: [], waHolidays: new Set() })
    expect(r.responded).toEqual({ n: 0, withinTarget: 0, pct: null, isEmpty: true, isLowN: false })
    expect(r.resolved).toEqual({ n: 0, withinTarget: 0, pct: null, isEmpty: true, isLowN: false })
  })

  it('tickets exist but none have a first_response_at → responded sub-metric is empty (FRSTAMP inert)', () => {
    // The reality today: 4 tickets, 0 with a first-response timestamp, 2 resolved.
    const tickets = [
      ticket({ resolvedAtUtc: '2026-06-20T02:00:00Z' }),
      ticket({ resolvedAtUtc: '2026-06-20T02:00:00Z' }),
      ticket({}),
      ticket({}),
    ]
    const r = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    // No first_response_at on any row → responded.n === 0 → isEmpty true.
    expect(r.responded.n).toBe(0)
    expect(r.responded.isEmpty).toBe(true)
    expect(r.responded.pct).toBeNull()
    // Resolution counts only rows with a resolution timestamp → n === 2 (low-n).
    expect(r.resolved.n).toBe(2)
  })
})

describe('computeServiceTicketSla — response sub-SLA (3 working days)', () => {
  it('response n counts only tickets with a non-null first_response_at', () => {
    const tickets = [
      ticket({ firstResponseAtAwst: '2026-06-16' }), // counted
      ticket({ firstResponseAtAwst: null }), // not counted
      ticket({ firstResponseAtAwst: '2026-06-17' }), // counted
    ]
    const r = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    expect(r.responded.n).toBe(2)
  })

  it('first response within 3 working days passes', () => {
    // created Mon 06-15 → responded Thu 06-18. (06-15, 06-18] = Tue, Wed, Thu = 3 wd ≤ 3.
    const r = computeServiceTicketSla({
      tickets: [ticket({ firstResponseAtAwst: '2026-06-18' })],
      waHolidays: new Set(),
    })
    expect(r.responded.withinTarget).toBe(1)
  })

  it('first response on the boundary (exactly 3 working days) passes (≤, not <)', () => {
    // created Mon 06-15 → responded Thu 06-18 = exactly 3 working days → within target.
    const r = computeServiceTicketSla({
      tickets: [ticket({ firstResponseAtAwst: '2026-06-18' })],
      waHolidays: new Set(),
    })
    expect(r.responded.withinTarget).toBe(1)
    expect(r.responded.pct).toBe(100)
  })

  it('first response over 3 working days fails', () => {
    // created Mon 06-15 → responded Fri 06-19. (06-15, 06-19] = Tue, Wed, Thu, Fri = 4 wd > 3.
    const r = computeServiceTicketSla({
      tickets: [ticket({ firstResponseAtAwst: '2026-06-19' })],
      waHolidays: new Set(),
    })
    expect(r.responded.withinTarget).toBe(0)
  })

  it('a same-day first response (0 working days) is within target', () => {
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-15', firstResponseAtAwst: '2026-06-15' })],
      waHolidays: new Set(),
    })
    expect(r.responded.n).toBe(1)
    expect(r.responded.withinTarget).toBe(1)
  })

  it('a weekend response counts as within target (no working days elapsed)', () => {
    // created Fri 06-19 → responded Sun 06-21. (06-19, 06-21] = Sat, Sun = 0 working days ≤ 3.
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-19', firstResponseAtAwst: '2026-06-21' })],
      waHolidays: new Set(),
    })
    expect(r.responded.withinTarget).toBe(1)
  })

  it('a WA holiday in the response window extends the working-day deadline', () => {
    // created Wed 2025-12-31 → responded Tue 2026-01-06.
    // weekdays in window: Thu 01-01, Fri 01-02, Mon 01-05, Tue 01-06 = 4, minus
    // New Year's Day 01-01 holiday = 3 working days → still within target.
    const tickets = [
      ticket({ createdAtAwst: '2025-12-31', firstResponseAtAwst: '2026-01-06' }),
    ]
    const withHoliday = computeServiceTicketSla({ tickets, waHolidays: new Set(['2026-01-01']) })
    expect(withHoliday.responded.withinTarget).toBe(1)
    // Without the holiday the same span is 4 working days → over target.
    const noHoliday = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    expect(noHoliday.responded.withinTarget).toBe(0)
  })
})

describe('computeServiceTicketSla — resolution sub-SLA (30 calendar days)', () => {
  it('resolution n counts only tickets with a resolution timestamp', () => {
    const tickets = [
      ticket({ resolvedAtUtc: '2026-06-20T02:00:00Z' }), // counted
      ticket({ resolvedAtUtc: null }), // not counted
      ticket({ resolvedAtUtc: '2026-07-01T02:00:00Z' }), // counted
    ]
    const r = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    expect(r.resolved.n).toBe(2)
  })

  it('resolution within 30 calendar days passes', () => {
    // created 2026-06-01, resolved 2026-06-20 (19 calendar days) → within target.
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-06-20T02:00:00Z' })],
      waHolidays: new Set(),
    })
    expect(r.resolved.withinTarget).toBe(1)
  })

  it('resolution on the boundary (exactly 30 calendar days) passes (≤, not <)', () => {
    // created 2026-06-01 → AWST-resolved 2026-07-01 = exactly 30 calendar days.
    // 2026-07-01T00:00:00Z → AWST 2026-07-01T08:00 → AWST date 2026-07-01.
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-07-01T00:00:00Z' })],
      waHolidays: new Set(),
    })
    expect(r.resolved.withinTarget).toBe(1)
  })

  it('resolution over 30 calendar days fails', () => {
    // created 2026-06-01 → resolved 2026-07-05 (34 calendar days) → over target.
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-07-05T02:00:00Z' })],
      waHolidays: new Set(),
    })
    expect(r.resolved.withinTarget).toBe(0)
  })

  it('resolution uses the AWST date of the UTC timestamp (TZ boundary)', () => {
    // created 2026-06-01. resolvedAtUtc = 2026-06-30T17:00:00Z = 2026-07-01T01:00 AWST.
    // AWST resolution date = 2026-07-01 → 30 calendar days → within target. A naive
    // UTC ::date would read 2026-06-30 (29 days) — same verdict here, but the AWST
    // path is the contract. Push it one second later to cross the AWST midnight:
    // 2026-07-01T16:00:01Z = 2026-07-02T00:00 AWST → 31 days → over target.
    const within = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-06-30T17:00:00Z' })],
      waHolidays: new Set(),
    })
    expect(within.resolved.withinTarget).toBe(1)
    const over = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-07-01T16:00:01Z' })],
      waHolidays: new Set(),
    })
    expect(over.resolved.withinTarget).toBe(0)
  })

  it('resolution is calendar days — holidays and weekends do NOT extend it', () => {
    // A 30-day calendar span straddling weekends/holidays still fails at day 31.
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-07-02T02:00:00Z' })],
      waHolidays: new Set(['2026-06-08', '2026-06-15']),
    })
    // 2026-07-02 AWST is 31 calendar days after 2026-06-01 → over target.
    expect(r.resolved.withinTarget).toBe(0)
  })

  it('COALESCE(resolved_at, closed_at): consumer passes whichever is present as resolvedAtUtc', () => {
    // The fold already does COALESCE; the pure fn just trusts resolvedAtUtc.
    // A ticket closed without an explicit resolved_at arrives with closed_at here.
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-06-10T02:00:00Z' })],
      waHolidays: new Set(),
    })
    expect(r.resolved.n).toBe(1)
    expect(r.resolved.withinTarget).toBe(1)
  })
})

describe('computeServiceTicketSla — pct + low-n gating', () => {
  it('pct is null when a sub-metric n is 0', () => {
    const r = computeServiceTicketSla({
      tickets: [ticket({ firstResponseAtAwst: '2026-06-16' })], // responded only
      waHolidays: new Set(),
    })
    expect(r.responded.n).toBe(1)
    expect(r.responded.pct).toBe(100)
    expect(r.resolved.n).toBe(0)
    expect(r.resolved.pct).toBeNull()
  })

  it('below LOW_N (0 < n < 5) flags isLowN but still reports a pct', () => {
    const tickets = [
      ticket({ resolvedAtUtc: '2026-06-10T02:00:00Z' }),
      ticket({ resolvedAtUtc: '2026-06-10T02:00:00Z' }),
      ticket({ createdAtAwst: '2026-05-01', resolvedAtUtc: '2026-07-30T02:00:00Z' }), // over 30 days
    ]
    const r = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    expect(r.resolved.n).toBe(3)
    expect(r.resolved.withinTarget).toBe(2)
    expect(r.resolved.isEmpty).toBe(false)
    expect(r.resolved.isLowN).toBe(true)
    // pct still computed (raw fraction); the renderer decides whether to colour it.
    expect(r.resolved.pct).toBeCloseTo((2 / 3) * 100, 5)
  })

  it('at exactly LOW_N (n === 5) clears the low-n flag (boundary)', () => {
    const tickets = Array.from({ length: 5 }, () =>
      ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: '2026-06-10T02:00:00Z' }),
    )
    const r = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    expect(r.resolved.n).toBe(5)
    expect(r.resolved.isLowN).toBe(false)
    expect(r.resolved.isEmpty).toBe(false)
    expect(r.resolved.pct).toBe(100)
  })

  it('the two sub-metrics gate independently (responded at-n, resolved low-n)', () => {
    const tickets = [
      // 5 responded (at-n), only 2 resolved (low-n)
      ...Array.from({ length: 5 }, (_, i) =>
        ticket({
          createdAtAwst: '2026-06-15',
          firstResponseAtAwst: '2026-06-16',
          resolvedAtUtc: i < 2 ? '2026-06-20T02:00:00Z' : null,
        }),
      ),
    ]
    const r = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    expect(r.responded.n).toBe(5)
    expect(r.responded.isLowN).toBe(false)
    expect(r.resolved.n).toBe(2)
    expect(r.resolved.isLowN).toBe(true)
  })

  it('a fully-tracked, all-passing batch reports 100% on both sub-metrics', () => {
    const tickets = Array.from({ length: 6 }, () =>
      ticket({
        createdAtAwst: '2026-06-01',
        firstResponseAtAwst: '2026-06-02',
        resolvedAtUtc: '2026-06-10T02:00:00Z',
      }),
    )
    const r = computeServiceTicketSla({ tickets, waHolidays: new Set() })
    expect(r.responded.pct).toBe(100)
    expect(r.resolved.pct).toBe(100)
    expect(r.responded.isLowN).toBe(false)
    expect(r.resolved.isLowN).toBe(false)
  })
})

describe('computeServiceTicketSla — invalid / defensive inputs', () => {
  it('a malformed createdAtAwst on a ticket does not throw and yields no within-target credit', () => {
    // An unparseable date → workingDaysBetween / calendar diff produce no pass.
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: 'not-a-date', firstResponseAtAwst: '2026-06-16', resolvedAtUtc: '2026-06-20T02:00:00Z' })],
      waHolidays: new Set(),
    })
    // Still counted in n (timestamp present) but not credited as within target.
    expect(r.responded.n).toBe(1)
    expect(r.responded.withinTarget).toBe(0)
    expect(r.resolved.n).toBe(1)
    expect(r.resolved.withinTarget).toBe(0)
  })

  it('a malformed resolvedAtUtc does not throw and is not credited', () => {
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2026-06-01', resolvedAtUtc: 'garbage' })],
      waHolidays: new Set(),
    })
    expect(r.resolved.n).toBe(1)
    expect(r.resolved.withinTarget).toBe(0)
  })

  it('accepts an array (Iterable) of holidays as well as a Set', () => {
    const r = computeServiceTicketSla({
      tickets: [ticket({ createdAtAwst: '2025-12-31', firstResponseAtAwst: '2026-01-06' })],
      waHolidays: ['2026-01-01'],
    })
    expect(r.responded.withinTarget).toBe(1)
  })
})
