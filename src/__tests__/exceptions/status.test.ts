import { describe, it, expect } from 'vitest'
import {
  OPEN_INVESTIGATION_STATUSES,
  OPEN_EXCEPTION_FILTER_STATUSES,
} from '@/lib/exceptions/status'

// The exact status groupings Dan decided in the NCN/NP investigations plan
// (docs/superpowers/specs/2026-07-06-ncn-np-investigations-model-design.md):
//   badge + dashboard "open investigation" = Disputed + Under Review
//   table default "open" filter             = Issued + Disputed + Under Review
describe('exception status sets', () => {
  it('open investigation = Disputed + Under Review only', () => {
    expect([...OPEN_INVESTIGATION_STATUSES].sort()).toEqual(['Disputed', 'Under Review'])
  })

  it('table default-open adds Issued to the open-investigation set', () => {
    expect([...OPEN_EXCEPTION_FILTER_STATUSES].sort()).toEqual([
      'Disputed',
      'Issued',
      'Under Review',
    ])
  })

  it('every open-investigation status is in the table default-open set (subset)', () => {
    for (const s of OPEN_INVESTIGATION_STATUSES) {
      expect(OPEN_EXCEPTION_FILTER_STATUSES).toContain(s)
    }
  })

  it('excludes terminal states from the badge (Disputed/Under Review only)', () => {
    for (const terminal of ['Resolved', 'Rescheduled', 'Rebooked', 'Closed', 'Issued']) {
      expect(OPEN_INVESTIGATION_STATUSES as readonly string[]).not.toContain(terminal)
    }
  })
})
