# Monthly Client Reports (PDF) — Design

**Date:** 2026-08-06
**Status:** Approved design, pending implementation plan
**Why (needed):** Gives each council a defensible, crew-confirmed quantity record backing the monthly invoice — protects real money on both sides of the bill.

## What

A downloadable, client-branded PDF per client per month, backing the monthly service invoice. Contractor-admin only.

- **Kwinana:** rows = collection areas ("Area 1"–"Area 4"), columns = services (Bulk Waste, Green Waste, E-Waste, Mattress, Whitegoods, Illegal Dumping).
- **WMRC (Verge Valet):** rows = **sub-clients** (never individual areas), columns = services (Bulk Waste, Green Waste, Illegal Dumping, Mattress).
- **Section 1 — Chargeable Collections** (page 1): allocation/free units only. These quantities are the invoice basis.
- **Section 2 — Verge Valet Extra (Resident-Paid)** (page 2): `is_extra` units by service/stream, same table shape. Not chargeable to the council; excluded from Section 1 totals.
- Counts only — no dollar amounts, no rates (invoice itself stays in Xero/DM-Ops).
- No comparisons or trend content in v1 (invoicing document; comparisons would be a separate, later section).

## Counting rule (the money rule)

A unit counts when:

1. The booking finished **Completed** (cancelled, NCN, NP excluded), and
2. its **collection date** falls inside the report month (`booking_item.collection_date_id → collection_date.date`), and
3. quantity = `actual_services ?? no_services` (crew-confirmed actuals win; `??` not `||` — a confirmed 0 must override the booked quantity; same convention as `volume-mix.ts` and `nightly-sync-to-dm-ops`).

Free vs Extra split = `booking_item.is_extra`. Only free units appear in Section 1; only extra units in Section 2.

**Mattresses:**
- KWN books Mattress as its own service → normal `booking_item` counting via `service.is_mattress` (never the display name — rename gotcha #228).
- VV rolls regular mattresses into the bulk booking → the regular-mattress figure comes from summing `collection_stop.mattress_count` over stops of `client.mattress_closeout_stream` whose booking is Completed in the month. Crew-logged data exists **from 01/08/2026 only** — earlier months render an em-dash with a footnote, not a fake 0.
- Extra mattresses everywhere = `is_extra` items on an `is_mattress` service.

## Data — one RPC

`get_client_monthly_report(p_client_id uuid, p_month date)` — SECURITY DEFINER, following the `get_reports_monthly` pattern. Returns long-format rows:

```
(group_key text, group_label text, service_name text, waste_stream waste_stream,
 is_mattress boolean, is_extra boolean, units bigint)
```

- **Grouping derived from the client:** client has sub-clients → group by sub-client; otherwise by collection area. No new config column.
- Crew-logged VV mattress counts are returned as additional rows (distinguishable via a source discriminator or `is_mattress + waste_stream` shape — plan decides the exact encoding).
- **Guard (per §21 rules):** NULL-safe role gate `(current_user_role() = 'contractor-admin') IS TRUE`; `REVOKE EXECUTE FROM PUBLIC, anon`; `SET search_path = public, pg_temp`; stable helpers wrapped in `(select …)`; guard keyed on the small relation.

## PDF — @react-pdf/renderer

Server-side in a Next.js route handler: `GET /admin/reports/client-report/pdf?client=<id>&month=YYYY-MM` → validates contractor-admin + client against `accessible_client_ids()` scope → calls RPC → renders → streams with `Content-Disposition: attachment; filename="<slug>-collections-<YYYY-MM>.pdf"`.

Rejected alternatives: headless Chromium (~300MB image + flaky on the Coolify VPS, overkill for tables); print-stylesheet (not a real downloadable file).

### Template (locked via /design-shotgun, 06/08/2026)

Reference implementation: [`2026-08-06-monthly-client-report-template.html`](./2026-08-06-monthly-client-report-template.html) (approved "Variant B — Statement", real July 2026 KWN data). Key decisions from the shotgun session:

- Navy brand band header: client logo, "Monthly Collections Statement", `client.service_name` subtitle, month + ref (`<SLUG>-<YYYY-MM>`) + issue date right-aligned.
- **No** summary tiles, **no** section sub-headings, **no** basis-of-preparation disclaimer, **no** web address in the footer.
- Section pill labels only: navy "Section 1 — Chargeable Collections", green "Section 2 — Verge Valet Extra (Resident-Paid)".
- Table: light header row, zebra rows, green-tinted Total column, navy "All Areas" total row (green-tinted grand total cell). Zeros rendered muted. `tabular-nums`.
- Rows labelled plainly ("Area 1", sub-client name) — no codes. Total row = "All Areas" (WMRC: "All Sub-clients" — confirm label at plan time).
- Fonts Poppins (headings) + DM Sans (body), registered TTFs in react-pdf.
- Brand colours from `client.primary_colour` / `client.accent_colour` (KWN: `#0d295a` / `#69a24c`).
- **Logo gotcha:** KWN's logo SVG is white-fill — logos must sit on the primary-colour band, never white. react-pdf renders SVG/PNG only from fetched bytes; plan must handle fetch + format.
- Footer: "Prepared for the **{client}** by **D&M Waste Management**" + page numbers.

## Surface + gate

"Client reports" card on `/admin/reports`, **contractor-admin only** (client-tier staff must not see it): page-level role check + the RPC gate (defence in depth, §12). Picker: client (via `fetchAccessibleClientOptions` — never a bare active-clients read, #456) + month (default = last complete month). No storage, no email, no cron.

## Testing

- Unit: aggregation/report-model 100% (money-adjacent) — counting rule, grouping derivation, mattress source selection, extra segregation, month boundaries (AWST vs UTC dates).
- RLS/role: every non-contractor-admin role gets zero rows/EXECUTE-denied from the RPC.
- Route: non-contractor-admin gets 403; valid request returns a well-formed PDF for both a by-area client (KWN) and a by-sub-client client (VV).

## Rollout

Types Freshness split (§21): **PR-A** migration (RPC) → release → **PR-B** types regen + route + PDF + UI. Verify PR-A on prod via `db query --linked` RAISE-rollback impersonation before building PR-B.

## Out of scope (v1)

Comparisons/trends, dollar amounts/rates, auto-email/cron, stored PDF archive, client-tier access, per-area WMRC breakdown.
