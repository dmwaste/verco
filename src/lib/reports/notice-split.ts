/**
 * Open-notices responsibility split (VER-294, decision from Dan 02/07).
 *
 * Both NCN and NP notices carry `contractor_fault`; every notice starts
 * resident-fault-PRESUMED (crew-issued assertion), residents get 14 days to
 * dispute, uncontested auto-close keeps the presumption, and staff can flip
 * to contractor fault at any time. The card therefore splits OPEN notices
 * three ways — the definitions doc v1.0 §3 states these mechanics to
 * councils; card labels must match it:
 *
 *   contractor        — fault flag set (a confirmed D&M service failure;
 *                       for an NP this means a dispute showed a missed pile)
 *   underInvestigation — Disputed / Under Review without a fault finding
 *   resident          — the remainder, incl. presumed (Issued / legacy Open)
 *
 * Terminal notices are excluded — this is a snapshot of open workload, not a
 * quality rate (that's Service Delivery, which counts confirmed contractor
 * faults only). Pure + deterministic; callers pass RLS-scoped rows.
 */

export const NCN_TERMINAL_STATUSES = ['Resolved', 'Rescheduled', 'Closed'] as const
export const NP_TERMINAL_STATUSES = ['Resolved', 'Rebooked', 'Closed'] as const

const UNDER_INVESTIGATION_STATUSES = new Set(['Disputed', 'Under Review'])

export interface NoticeRow {
  table: 'ncn' | 'np'
  status: string
  contractor_fault: boolean
}

export interface NoticeSplit {
  open: number
  contractor: number
  underInvestigation: number
  resident: number
}

function isTerminal(row: NoticeRow): boolean {
  const terminal: readonly string[] =
    row.table === 'ncn' ? NCN_TERMINAL_STATUSES : NP_TERMINAL_STATUSES
  return terminal.includes(row.status)
}

/** Splits notices three ways by responsibility; terminal rows are ignored. */
export function computeNoticeSplit(rows: readonly NoticeRow[]): NoticeSplit {
  let contractor = 0
  let underInvestigation = 0
  let resident = 0

  for (const row of rows) {
    if (isTerminal(row)) continue
    if (row.contractor_fault) {
      contractor += 1
    } else if (UNDER_INVESTIGATION_STATUSES.has(row.status)) {
      underInvestigation += 1
    } else {
      resident += 1
    }
  }

  return {
    open: contractor + underInvestigation + resident,
    contractor,
    underInvestigation,
    resident,
  }
}
