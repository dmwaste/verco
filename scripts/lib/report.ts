// scripts/lib/report.ts
//
// Shared report/CSV formatting helpers for the one-off reconcile/audit/backfill
// scripts. Extracted from the copies each script carried (issue #389.2).

/** Filename-safe local timestamp, e.g. `20260711-190500`. */
export function timestamp(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
}

/** Quote a CSV cell only when it contains a comma, quote, or newline (RFC 4180). */
export function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Collapse whitespace and truncate to `n` chars with an ellipsis. */
export function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}
