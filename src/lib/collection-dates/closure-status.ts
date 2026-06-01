/**
 * Closure-status decision for the admin Collection Dates "Open" column.
 *
 * A collection date can be closed for different reasons, and staff need to
 * tell them apart (VER-221: a WA public holiday closure looked identical to an
 * admin-toggled or capacity closure, generating confused support tickets).
 *
 * Rather than denormalise a `holiday_name` column onto every collection_date
 * row, the holiday name is resolved at read time against the `public_holiday`
 * table (already client-readable, already in the generated types). The caller
 * passes an ISO-date → holiday-name map built from that query.
 *
 *   is_open = true                          → 'open'    (green dot)
 *   is_open = false & date is a WA holiday  → 'holiday' (amber pill, named)
 *   is_open = false & not a holiday         → 'closed'  (grey dot)
 */
export type ClosureStatus = 'open' | 'holiday' | 'closed'

export function closureStatus(
  isOpen: boolean,
  date: string,
  holidayNames: ReadonlyMap<string, string>,
): ClosureStatus {
  if (isOpen) return 'open'
  if (holidayNames.has(date)) return 'holiday'
  return 'closed'
}
