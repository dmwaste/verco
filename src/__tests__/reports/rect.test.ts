import { describe, it, expect } from 'vitest'
import {
  computeRectSla,
  RECT_TARGET_PCT,
  RECT_LOW_N,
  type RectRow,
} from '@/lib/reports/rect'

/**
 * RECT — Rectification within 2 WORKING days (spec §3.3).
 *
 * Mirrors the `get_rect_sla` RPC logic so the working-day arithmetic is
 * DB-independent + unit-testable. Pure: compares two stored timestamps per row
 * via the shared `workingDaysBetween` helper — no Supabase, no wall-clock.
 *
 * Denominator = rows where the rebooked booking reached Completed
 * (`rebookedCompleted === true`). Numerator = those completed within ≤ 2 WA
 * working days of issue. In-flight rectifications (`rebookedCompleted === false`)
 * are pending, not failures — excluded from BOTH numerator and denominator.
 * `pct` is null when the denominator is 0 (empty / nothing-to-measure).
 *
 * Calendar anchors (verified, AWST = UTC+8, no DST):
 *   2026-06-15 Mon · 06-16 Tue · 06-17 Wed · 06-18 Thu · 06-19 Fri ·
 *   06-20 Sat · 06-21 Sun · 06-22 Mon · 06-23 Tue
 *   2026-01-23 Fri · 01-24 Sat · 01-25 Sun · 2026-01-26 Mon (Australia Day)
 */
describe('computeRectSla', () => {
  it('exports the spec constants (target 90%, low-n 5)', () => {
    expect(RECT_TARGET_PCT).toBe(90)
    expect(RECT_LOW_N).toBe(5)
  })

  // ── Empty ────────────────────────────────────────────────────────────────
  it('returns null pct for an empty input list', () => {
    expect(computeRectSla([], [])).toEqual({
      numerator: 0,
      denominator: 0,
      pct: null,
    })
  })

  it('returns null pct when every row is still in-flight (denominator 0)', () => {
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: null,
        rebookedCompleted: false,
      },
      {
        reportedAtIso: '2026-06-16',
        completedAtIso: null,
        rebookedCompleted: false,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 0,
      denominator: 0,
      pct: null,
    })
  })

  // ── Core ≤2 pass / >2 fail ─────────────────────────────────────────────────
  it('counts a rectification completed in exactly 2 working days as a pass', () => {
    // (Mon 06-15, Wed 06-17] = Tue, Wed = 2 working days → ≤ 2 → pass.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-17',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 1,
      denominator: 1,
      pct: 100,
    })
  })

  it('counts a rectification completed in 3 working days as a fail (still in denom)', () => {
    // (Mon 06-15, Thu 06-18] = Tue, Wed, Thu = 3 working days → > 2 → fail.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-18',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 0,
      denominator: 1,
      pct: 0,
    })
  })

  it('treats a same-day rectification (0 working days) as a pass', () => {
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-15',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 1,
      denominator: 1,
      pct: 100,
    })
  })

  // ── Working-days across a weekend ─────────────────────────────────────────
  it('passes a rectification spanning a weekend (Fri → Tue is 2 working days)', () => {
    // (Fri 06-19, Tue 06-23] = Sat, Sun (skipped), Mon 22, Tue 23 = 2 working days.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-19',
        completedAtIso: '2026-06-23',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 1,
      denominator: 1,
      pct: 100,
    })
  })

  // ── Working-days across a WA public holiday ───────────────────────────────
  it('passes a span that would be 3 working days but for a WA holiday in the window', () => {
    // (Fri 06-19, Wed 06-24] weekdays = Mon22, Tue23, Wed24 = 3 working days.
    // With Mon 06-22 a WA holiday → 3 - 1 = 2 → ≤ 2 → pass.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-19',
        completedAtIso: '2026-06-24',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, ['2026-06-22'])).toEqual({
      numerator: 1,
      denominator: 1,
      pct: 100,
    })
  })

  it('fails the same span without the holiday list (3 working days)', () => {
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-19',
        completedAtIso: '2026-06-24',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 0,
      denominator: 1,
      pct: 0,
    })
  })

  it('subtracts the real Australia Day holiday so Fri → Tue stays 1 working day', () => {
    // (Fri 01-23, Tue 01-27] weekdays = Mon26, Tue27 = 2. Australia Day Mon
    // 01-26 is a WA holiday → 2 - 1 = 1 working day → pass.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-01-23',
        completedAtIso: '2026-01-27',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, ['2026-01-26'])).toEqual({
      numerator: 1,
      denominator: 1,
      pct: 100,
    })
  })

  // ── AWST cast at the UTC-day boundary ─────────────────────────────────────
  it('uses the AWST calendar date, not naive UTC, at the midnight boundary', () => {
    // reported = 2026-06-15T17:00Z = 06-16 01:00 AWST → AWST date 06-16.
    // completed = 2026-06-17T17:00Z = 06-18 01:00 AWST → AWST date 06-18.
    // (06-16, 06-18] = Wed17, Thu18 = 2 working days → pass. A naive UTC ::date
    // would bucket reported to 06-15 and count 3 → fail.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15T17:00:00Z',
        completedAtIso: '2026-06-17T17:00:00Z',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 1,
      denominator: 1,
      pct: 100,
    })
  })

  // ── In-flight excluded from BOTH sides ────────────────────────────────────
  it('excludes in-flight rows from both numerator and denominator', () => {
    const rows: RectRow[] = [
      // pass, completed
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-17',
        rebookedCompleted: true,
      },
      // in-flight: rebooked but not yet Completed → excluded both sides
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: null,
        rebookedCompleted: false,
      },
      // fail, completed
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-18',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 1,
      denominator: 2,
      pct: 50,
    })
  })

  // ── Percentage rounding ───────────────────────────────────────────────────
  it('rounds the percentage to one decimal place', () => {
    // 2 of 3 within target → 66.666… → 66.7.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-17',
        rebookedCompleted: true,
      },
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-16',
        rebookedCompleted: true,
      },
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-18',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 2,
      denominator: 3,
      pct: 66.7,
    })
  })

  // ── Low-n boundary (LOW_N = 5) ────────────────────────────────────────────
  it('still computes pct below LOW_N — the threshold is a render concern, not a calc one', () => {
    // 4 completed rectifications (< 5). The pure fn returns the honest fraction;
    // the consumer decides whether to colour it (≥ LOW_N) or label "Building data".
    const rows: RectRow[] = Array.from({ length: 4 }, () => ({
      reportedAtIso: '2026-06-15',
      completedAtIso: '2026-06-17',
      rebookedCompleted: true,
    }))
    const result = computeRectSla(rows, [])
    expect(result.denominator).toBe(4)
    expect(result.denominator).toBeLessThan(RECT_LOW_N)
    expect(result.pct).toBe(100)
  })

  it('computes pct at exactly LOW_N completed rectifications', () => {
    const rows: RectRow[] = Array.from({ length: RECT_LOW_N }, () => ({
      reportedAtIso: '2026-06-15',
      completedAtIso: '2026-06-17',
      rebookedCompleted: true,
    }))
    const result = computeRectSla(rows, [])
    expect(result.denominator).toBe(RECT_LOW_N)
    expect(result.pct).toBe(100)
  })

  // ── Null / invalid inputs ─────────────────────────────────────────────────
  it('treats a completed-flagged row with a null completion timestamp as a non-pass (still in denom)', () => {
    // Defensive: rebookedCompleted true but no completedAtIso. It IS a completed
    // rectification by the flag (counts in the denominator) but has no measurable
    // duration → cannot be within 2 working days → not counted in numerator.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: null,
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 0,
      denominator: 1,
      pct: 0,
    })
  })

  it('treats an unparseable completion timestamp as a non-pass (still in denom)', () => {
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: 'not-a-date',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 0,
      denominator: 1,
      pct: 0,
    })
  })

  it('treats an unparseable reported timestamp as a non-pass (still in denom)', () => {
    const rows: RectRow[] = [
      {
        reportedAtIso: 'not-a-date',
        completedAtIso: '2026-06-17',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 0,
      denominator: 1,
      pct: 0,
    })
  })

  it('completion strictly before reported (negative span) is a non-pass (still in denom)', () => {
    // workingDaysBetween returns 0 when end <= start, but a negative real span is
    // a data anomaly, not a 0-working-day pass. Guard it as a non-pass.
    const rows: RectRow[] = [
      {
        reportedAtIso: '2026-06-18',
        completedAtIso: '2026-06-15',
        rebookedCompleted: true,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 0,
      denominator: 1,
      pct: 0,
    })
  })

  // ── Mixed realistic dataset ───────────────────────────────────────────────
  it('folds a mixed NCN + NP dataset (passes, fails, and in-flight) correctly', () => {
    const rows: RectRow[] = [
      // pass — 1 working day
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-16',
        rebookedCompleted: true,
      },
      // pass — weekend-spanning 2 working days
      {
        reportedAtIso: '2026-06-19',
        completedAtIso: '2026-06-23',
        rebookedCompleted: true,
      },
      // fail — 3 working days
      {
        reportedAtIso: '2026-06-15',
        completedAtIso: '2026-06-18',
        rebookedCompleted: true,
      },
      // in-flight — excluded both sides
      {
        reportedAtIso: '2026-06-20',
        completedAtIso: null,
        rebookedCompleted: false,
      },
    ]
    expect(computeRectSla(rows, [])).toEqual({
      numerator: 2,
      denominator: 3,
      pct: 66.7,
    })
  })
})
