// scripts/lib/csv.ts
// Minimal RFC-4180 CSV reader for the Airtable exports the import scripts
// consume (quoted fields with commas/quotes/newlines, BOM-tolerant). Returns
// one object per row keyed by the trimmed header names.

export type CsvRow = Record<string, string>

export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else q = false
      } else field += c
    } else if (c === '"') q = true
    else if (c === ',') { cur.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      cur.push(field); field = ''
      if (cur.some((x) => x !== '')) rows.push(cur)
      cur = []
    } else field += c
  }
  if (field !== '' || cur.length) { cur.push(field); if (cur.some((x) => x !== '')) rows.push(cur) }
  const header = rows[0]!.map((h) => h.replace(/^﻿/, '').trim())
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}
