// scripts/lib/airtable-bookings.ts
//
// Fetch the consolidated Airtable `Bookings` master (the source of truth for
// VV cancellations/reschedules/edits), filtered to a set of council codes.
// Mirrors the REST + pagination + retry shape of airtable-vv.ts.

import type { SourceBooking, SourceStatus } from './reconcile'

const PAGE_SIZE = 100
const RETRY_BACKOFF_MS = 1000
const MAX_RETRIES = 5

/** Consolidated Bookings table in the "Verge Valet Bookings" base. */
export const BOOKINGS_TABLE_ID = 'tblEeFl72RfabcuFE'

// Field IDs (stable across renames — we request returnFieldsByFieldId=true).
const F = {
  bookingRef: 'fldqrIEIm18oTWAGg',
  status: 'fldgsq0lJYqPTPjEz',
  eligibleProperties: 'fldYGXUHswF9tFQn3',
  collectionDate: 'fldTJqqPiMPsCFWcP', // lookup: array of "YYYY-MM-DD"
  noBulk: 'fldquMnXoXziV6O9l',
  noGreen: 'fldvpxHlXrYMhDJiT',
  noMattress: 'fldHpGRMDzHSlVRCH', // singleSelect ("0"/"1"/"2"…)
  wasteLocation: 'fld28T2IJgeWPQNEQ', // singleSelect (Front Verge / Side Verge / …)
  modifiedTime: 'fldoURZlVBVmsErjF',
} as const

// filterByFormula references field NAMES, not ids.
const COUNCIL_FIELD_NAME = '{Council_Code (from Eligible Properties)}'

const VALID_STATUSES: readonly SourceStatus[] = [
  'Booked',
  'Place Out Issued',
  'Scheduled',
  'Completed',
  'Non-Conformance',
  'Cancelled',
]

type RawFields = Record<string, unknown>
type AirtableListResponse = { records: Array<{ id: string; fields: RawFields }>; offset?: string }

/**
 * Fetch every consolidated Bookings row whose property's council is in
 * `councilCodes`. Returns parsed rows plus a count of rows skipped because they
 * lacked a linked property or a recognised status (can't be reconciled).
 */
export async function fetchConsolidatedBookings(
  baseId: string,
  token: string,
  councilCodes: string[],
): Promise<{ rows: SourceBooking[]; skipped: number }> {
  const formula = councilFilterFormula(councilCodes)
  const rows: SourceBooking[] = []
  let skipped = 0
  let offset: string | undefined

  do {
    const params = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
      returnFieldsByFieldId: 'true',
      filterByFormula: formula,
    })
    if (offset) params.set('offset', offset)
    const url = `https://api.airtable.com/v0/${baseId}/${BOOKINGS_TABLE_ID}?${params}`
    const body = await airtableFetch<AirtableListResponse>(url, token)
    for (const rec of body.records) {
      const parsed = parseRow(rec.id, rec.fields)
      if (parsed) rows.push(parsed)
      else skipped++
    }
    offset = body.offset
  } while (offset)

  return { rows, skipped }
}

function parseRow(id: string, f: RawFields): SourceBooking | null {
  // Linked-record fields come back as arrays of record-id strings.
  const propertyRecId = (f[F.eligibleProperties] as string[] | undefined)?.[0]
  if (!propertyRecId) return null

  const statusName = f[F.status] as string | undefined
  if (!statusName || !VALID_STATUSES.includes(statusName as SourceStatus)) return null

  const collectionDate = (f[F.collectionDate] as string[] | undefined)?.[0] ?? null

  return {
    recordId: id,
    bookingRef: String(f[F.bookingRef] ?? id),
    propertyRecId,
    collectionDate,
    status: statusName as SourceStatus,
    noBulk: num(f[F.noBulk]),
    noGreen: num(f[F.noGreen]),
    noMattress: num(f[F.noMattress]),
    wasteLocation: (f[F.wasteLocation] as string | undefined) ?? null,
    modifiedAt: String(f[F.modifiedTime] ?? ''),
  }
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function councilFilterFormula(codes: string[]): string {
  const terms = codes.map((c) => `FIND("${c}",ARRAYJOIN(${COUNCIL_FIELD_NAME}))`)
  return `OR(${terms.join(',')})`
}

async function airtableFetch<T>(url: string, token: string): Promise<T> {
  let attempt = 0
  while (true) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) return (await res.json()) as T
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(RETRY_BACKOFF_MS * Math.pow(2, attempt))
      attempt++
      continue
    }
    throw new Error(`Airtable HTTP ${res.status} for ${url}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
