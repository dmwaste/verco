/**
 * Nothing Presented — dwelling-type split (#459, WMRC 29/07).
 *
 * WMRC wants to see whether NP notices skew to multi-unit dwellings (shared
 * bin areas, strata comms chains) or standard properties — it drives where
 * they aim resident education. Counts EVERY notice in the period regardless
 * of status (this is an incidence measure, not an open-workload snapshot —
 * unlike notice-split.ts, which deliberately excludes terminal rows).
 *
 * A notice whose booking has no linked property (legacy/ID edge cases) counts
 * as standard — never silently dropped, so the donut total always matches the
 * notice count. Pure + deterministic; callers pass RLS-scoped rows.
 */

export interface NpDwellingRow {
  is_mud: boolean | null
}

export interface NpDwellingSplit {
  mud: number
  standard: number
}

export function computeNpDwellingSplit(rows: readonly NpDwellingRow[]): NpDwellingSplit {
  let mud = 0
  let standard = 0
  for (const row of rows) {
    if (row.is_mud === true) mud += 1
    else standard += 1
  }
  return { mud, standard }
}
