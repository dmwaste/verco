// scripts/lib/airtable-mud.ts
// Fetches the MUD List table from the main Verge Valet Airtable base.
//
// Field IDs (from `tblmKPAzNLWyJoztY` in base `appWSysd50QoVaaRD`):
//   fldZDp16NHVleECcP  Address           (text)
//   fld8BiueJOpyJb0Ox  MUD Ref           (text)
//   fldKTLD0IrNPO7AVA  Units             (number)
//   fldgfeSAUV7lh5rDJ  Status            (singleSelect → plain string via REST)
//   fldND8tQvk1KxN3Wj  Contact Name      (text)
//   fldFTA8sq8GRtFytn  Contact Number    (text)
//   fldNa332Tg6i8TOx9  Email             (email → text)
//   fldMs9geQD3vin20Y  Notes             (text)
//   fld6BDNnKt6QcArhq  Collection Frequency (Months) (number)
//   fld6XqV6ol8PEaBOh  Off Street Collection Agreed  (checkbox → boolean)
//   fldCFOUSHN9oHPUG3  Council Code      (multipleRecordLinks → string[])
//   fldsz4Vo5Rhyg2DqW  Registration Form (multipleAttachments)
//
// The Council Code linked records are resolved to names via the shared
// Council Code lookup table (tbl99oRF44wTsY7ec) — same as airtable-vv.ts.

import { fetchCouncilCodeLookup } from './airtable-vv'
import type { AirtableMudRecord } from './types'

export const MUD_BASE_ID = 'appWSysd50QoVaaRD'
const MUD_LIST_TABLE_ID = 'tblmKPAzNLWyJoztY'
const PAGE_SIZE = 100
const MAX_RETRIES = 5
const RETRY_BACKOFF_MS = 1000

type AirtableListResponse<TFields> = {
  records: Array<{ id: string; fields: TFields }>
  offset?: string
}

type MudFields = {
  fldZDp16NHVleECcP?: string    // Address
  fld8BiueJOpyJb0Ox?: string    // MUD Ref
  fldKTLD0IrNPO7AVA?: number    // Units
  fldgfeSAUV7lh5rDJ?: string    // Status (singleSelect, REST returns plain string)
  fldND8tQvk1KxN3Wj?: string    // Contact Name
  fldFTA8sq8GRtFytn?: string    // Contact Number
  fldNa332Tg6i8TOx9?: string    // Email
  fldMs9geQD3vin20Y?: string    // Notes
  fld6BDNnKt6QcArhq?: number    // Collection Frequency (Months)
  fld6XqV6ol8PEaBOh?: boolean   // Off Street Collection Agreed
  fldCFOUSHN9oHPUG3?: string[]  // Council Code (linked-record IDs)
  fldsz4Vo5Rhyg2DqW?: Array<{   // Registration Form (attachments)
    url: string
    filename: string
    size?: number
    type?: string
  }>
}

/**
 * Fetch all records from the MUD List table in the main VV base,
 * with council codes resolved to their name (e.g. "FRE-S").
 */
export async function fetchAllMudRecords(token: string): Promise<AirtableMudRecord[]> {
  const codeLookup = await fetchCouncilCodeLookup(MUD_BASE_ID, token)

  const results: AirtableMudRecord[] = []
  let offset: string | undefined = undefined

  do {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE), returnFieldsByFieldId: 'true' })
    if (offset) params.set('offset', offset)
    const url = `https://api.airtable.com/v0/${MUD_BASE_ID}/${MUD_LIST_TABLE_ID}?${params}`
    const body = await airtableFetch<AirtableListResponse<MudFields>>(url, token)

    for (const rec of body.records) {
      const f = rec.fields
      const codeId = f.fldCFOUSHN9oHPUG3?.[0]
      const councilCodeName = codeId ? (codeLookup.get(codeId) ?? null) : null

      const attachment = f.fldsz4Vo5Rhyg2DqW?.[0] ?? null

      results.push({
        id: rec.id,
        address: f.fldZDp16NHVleECcP ?? '',
        mudRef: f.fld8BiueJOpyJb0Ox ?? null,
        units: f.fldKTLD0IrNPO7AVA ?? 0,
        status: f.fldgfeSAUV7lh5rDJ ?? null,
        contactName: f.fldND8tQvk1KxN3Wj ?? null,
        contactNumber: f.fldFTA8sq8GRtFytn ?? null,
        email: f.fldNa332Tg6i8TOx9 ?? null,
        notes: f.fldMs9geQD3vin20Y ?? null,
        frequencyMonths: f.fld6BDNnKt6QcArhq ?? 0,
        offStreetAgreed: f.fld6XqV6ol8PEaBOh ?? false,
        councilCodeName,
        authFormUrl: attachment?.url ?? null,
        authFormFilename: attachment?.filename ?? null,
      })
    }

    offset = body.offset
  } while (offset)

  return results
}

// ─── KWN MUD List ─────────────────────────────────────────────────────────────
//
// Base: apppzIjIc05ghcixH  (Kwinana Pre-booked Verge Collection)
// Table: tblsF6QreqldGGGuR  (MUD List)
//
// Area resolution: the linked Area Code record ID maps directly to a Verco
// collection_area.id — no secondary lookup required (only 4 KWN areas).
//
// Field IDs:
//   fld2oVgiRY675Jhcl  Address
//   fldVLnOFGpwU6ZZ4e  MUD Ref
//   fldn3S8COi8d1mz9g  Units
//   fldYNV5uZhxDqhVRP  Status (singleSelect)
//   fldEiT6ScRRO67N6m  Collection Frequency (Months)
//   fldhdCEjqKuZHneco  Area Code (multipleRecordLinks → Area Code table)
//   fldhw5qjkVZf0FzfY  Contact Name
//   fldG2CsPX3K4iOPFE  Contact Number
//   fld36Bz49QvM8fOb5  Email
//   fldS9dFQgOXtJKdQ5  Registration Form (multipleAttachments)
//   fldTTfb6B73KuhFPS  Off Street Collection Agreed (checkbox)
//   fldHRmuS5KLi6TNJy  Notes

export const KWN_BASE_ID = 'apppzIjIc05ghcixH'
const KWN_MUD_TABLE_ID = 'tblsF6QreqldGGGuR'

// Airtable Area Code record ID → Verco collection_area.id
// Confirmed 2026-05-22 against Verco DB (KWN-1 through KWN-4).
export const KWN_AREA_MAP: Record<string, string> = {
  'rec0JUtX1OS9qvnfk': 'dc857d39-832f-4ffd-b959-14e579e67d90', // Area 1 (Monday)  → KWN-1
  'recboCNUiuoo2avnw': '9594d907-89a7-4374-870c-caa51627b677', // Area 2 (Tuesday) → KWN-2
  'recuuR5MylfWdxO2M': '1ba489fc-d50a-4f87-9c0a-4518b4260c2d', // Area 3 (Wednesday) → KWN-3
  'recVbdLGdB6GlgPwE': 'd9f8e762-5376-410e-8855-bc73048724b4', // Area 4 (Thursday) → KWN-4
}

type KwnMudFields = {
  fld2oVgiRY675Jhcl?: string    // Address
  fldVLnOFGpwU6ZZ4e?: string    // MUD Ref
  fldn3S8COi8d1mz9g?: number    // Units
  fldYNV5uZhxDqhVRP?: string    // Status
  fldEiT6ScRRO67N6m?: number    // Collection Frequency (Months)
  fldhdCEjqKuZHneco?: string[]  // Area Code (linked record IDs)
  fldhw5qjkVZf0FzfY?: string    // Contact Name
  fldG2CsPX3K4iOPFE?: string    // Contact Number
  fld36Bz49QvM8fOb5?: string    // Email
  fldS9dFQgOXtJKdQ5?: Array<{ url: string; filename: string }>  // Registration Form
  fldTTfb6B73KuhFPS?: boolean   // Off Street Collection Agreed
  fldHRmuS5KLi6TNJy?: string    // Notes
}

export async function fetchAllKwnMudRecords(token: string): Promise<AirtableMudRecord[]> {
  const results: AirtableMudRecord[] = []
  let offset: string | undefined = undefined

  do {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE), returnFieldsByFieldId: 'true' })
    if (offset) params.set('offset', offset)
    const url = `https://api.airtable.com/v0/${KWN_BASE_ID}/${KWN_MUD_TABLE_ID}?${params}`
    const body = await airtableFetch<AirtableListResponse<KwnMudFields>>(url, token)

    for (const rec of body.records) {
      const f = rec.fields
      const areaRecordId = f.fldhdCEjqKuZHneco?.[0] ?? null
      // Resolve area record ID → area name string (used later for resolveAreaId)
      const councilCodeName = areaRecordId ? (KWN_AREA_NAME_MAP[areaRecordId] ?? null) : null
      const attachment = f.fldS9dFQgOXtJKdQ5?.[0] ?? null

      results.push({
        id: rec.id,
        address: f.fld2oVgiRY675Jhcl ?? '',
        mudRef: f.fldVLnOFGpwU6ZZ4e ?? null,
        units: f.fldn3S8COi8d1mz9g ?? 0,
        status: f.fldYNV5uZhxDqhVRP ?? null,
        contactName: f.fldhw5qjkVZf0FzfY ?? null,
        contactNumber: f.fldG2CsPX3K4iOPFE ?? null,
        email: f.fld36Bz49QvM8fOb5 ?? null,
        notes: f.fldHRmuS5KLi6TNJy ?? null,
        frequencyMonths: f.fldEiT6ScRRO67N6m ?? 0,
        offStreetAgreed: f.fldTTfb6B73KuhFPS ?? false,
        councilCodeName,
        authFormUrl: attachment?.url ?? null,
        authFormFilename: attachment?.filename ?? null,
      })
    }

    offset = body.offset
  } while (offset)

  return results
}

// Maps Airtable Area Code record IDs to short codes that area-map.ts can resolve.
// KWN area codes in Verco are KWN-1 through KWN-4.
const KWN_AREA_NAME_MAP: Record<string, string> = {
  'rec0JUtX1OS9qvnfk': 'KWN-1',
  'recboCNUiuoo2avnw': 'KWN-2',
  'recuuR5MylfWdxO2M': 'KWN-3',
  'recVbdLGdB6GlgPwE': 'KWN-4',
}

// ─── Shared fetch helper ──────────────────────────────────────────────────────

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
