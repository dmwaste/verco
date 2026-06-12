# VV eligible_properties duplicate cleanup

Background and root cause: see memory `eligible-properties-duplicate-imports.md`.

The Verge Valet Airtable bases contain **duplicate records for the same property**
— a correct one and a mis-sourced one (e.g. `"6 Grant Street COTTESLOE…"` vs
`"6 Grant ST PERTH"` mis-coded to the Vincent council code). The importer keyed
on the Airtable record id, so both became `eligible_properties` rows, and the
public booking lookup reported the address as **"not eligible"** (it bails when a
`google_place_id` resolves to >1 row).

## What's already fixed

| Layer | Fix | Where |
|---|---|---|
| Booking lookup | Hardened to resolve duplicate/ambiguous matches instead of "not eligible" | PR #182 |
| Verco data | Dedupe migration (848 dup groups → 0) | `supabase/migrations/20260612010000_dedupe_eligible_properties.sql` |
| Importer | `dedupeByPlaceId` guard — won't re-create duplicates on the next run | `scripts/lib/dedupe-properties.ts` + `import-vv-properties.ts` |

## This directory — Airtable source hygiene (optional)

The importer guard means stale Airtable duplicates are now **inert** (they won't
re-import). Cleaning them at source is good hygiene but not load-bearing.

`list-vv-airtable-dupes.sql` lists the Airtable records to delete — it mirrors
the migration's "delete" selection and emits `(airtable_base, airtable_record_id,
address, assigned_area, reason)`, keeping the correct copy and listing only the
redundant/mis-sourced one.

### Run it
```bash
# against the Verco Supabase project (tfddjmplcizfirxqhotv)
psql "$VERCO_DB_URL" -f scripts/cleanup/list-vv-airtable-dupes.sql --csv > vv-airtable-dupes.csv
```

### Snapshot (2026-06-12) — records to delete, by base

| Airtable base | template | same-area dup | cross-area | exception | total |
|---|--:|--:|--:|--:|--:|
| `appWSysd50QoVaaRD` | 4 | 655 | 18 | 1 | **678** |
| `appIgPfNX8SYS9QIq` | 2 | 245 | — | — | **247** |
| `appuf7kTSNFXi7Rp0` | — | 41 | — | — | **41** |

(~75 further duplicate rows came from non-Airtable imports (KWN/DM-Ops); they are
cleaned in Verco by the migration and are excluded from this Airtable list.)

### Acting on it
Delete the listed `airtable_record_id`s from each base's **Eligible Properties**
table. The records carry no Verco bookings (verified), so removal is safe. Re-run
the query afterwards to confirm an empty result.
