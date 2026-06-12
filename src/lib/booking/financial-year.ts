/**
 * Expand a short financial-year code into a resident-facing label.
 *
 *   "FY26" → "Financial Year 2025/26"
 *
 * An Australian FY is named for the calendar year it ends in (FY26 ends
 * 30 June 2026), so the friendly form spans the prior year to that one.
 * Display-only — the canonical `financial_year.label` ("FY26") stays as-is in
 * the DB and admin surfaces. Anything that doesn't match /^FY\d{2}$/ is
 * returned unchanged so an already-friendly or unexpected label passes through.
 */
export function formatFinancialYearLabel(label: string): string {
  const match = /^FY(\d{2})$/.exec(label.trim())
  if (!match) return label
  const endShort = match[1] // "26"
  const endFull = 2000 + Number(endShort) // 2026
  const startFull = endFull - 1 // 2025
  return `Financial Year ${startFull}/${endShort}`
}
