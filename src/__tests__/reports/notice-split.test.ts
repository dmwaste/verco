import { describe, expect, it } from 'vitest'
import { computeNoticeSplit, type NoticeRow } from '@/lib/reports/notice-split'

const row = (table: 'ncn' | 'np', status: string, contractor_fault = false): NoticeRow => ({
  table,
  status,
  contractor_fault,
})

describe('computeNoticeSplit (VER-294 three-way split)', () => {
  it('returns zeros for no input', () => {
    expect(computeNoticeSplit([])).toEqual({
      open: 0,
      contractor: 0,
      underInvestigation: 0,
      resident: 0,
    })
  })

  it('splits open notices three ways', () => {
    const split = computeNoticeSplit([
      row('ncn', 'Issued'), // resident-presumed
      row('ncn', 'Open'), // legacy value → resident-presumed
      row('np', 'Issued'), // NP included, same rules
      row('ncn', 'Disputed'), // under investigation
      row('np', 'Under Review'), // under investigation
      row('ncn', 'Under Review', true), // fault flag wins over status
      row('np', 'Issued', true), // staff-flagged without dispute
    ])
    expect(split).toEqual({ open: 7, contractor: 2, underInvestigation: 2, resident: 3 })
  })

  it('excludes terminal notices per table (NCN: Rescheduled; NP: Rebooked)', () => {
    const split = computeNoticeSplit([
      row('ncn', 'Resolved', true),
      row('ncn', 'Rescheduled'),
      row('ncn', 'Closed'),
      row('np', 'Resolved'),
      row('np', 'Rebooked', true),
      row('np', 'Closed'),
      // NCN has no Rebooked terminal; an NP-style status on an NCN stays open.
      row('ncn', 'Issued'),
    ])
    expect(split).toEqual({ open: 1, contractor: 0, underInvestigation: 0, resident: 1 })
  })

  it('counts a contractor-fault notice as contractor regardless of state', () => {
    const split = computeNoticeSplit([
      row('ncn', 'Issued', true),
      row('ncn', 'Disputed', true),
      row('np', 'Under Review', true),
    ])
    expect(split).toEqual({ open: 3, contractor: 3, underInvestigation: 0, resident: 0 })
  })
})
