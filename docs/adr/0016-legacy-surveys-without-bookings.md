# 0016 — Imported Airtable surveys live in Verco without a booking

- **Date:** 23/08/2026
- **Status:** Accepted

## Decision

A resident survey no longer has to belong to a Verco booking. `booking_survey.booking_id` is nullable for rows with `source = 'airtable'`; every survey now carries its own `collection_area_id` (filled from the booking automatically for surveys Verco creates itself). The Airtable survey history for each council is imported with `scripts/import-vv-surveys-csv.ts` when that council cuts over — 1,064 MOS/COT/PEP/VIN rows on 23/08/2026, Aug 2025 onward. No resident name, email or phone is carried across.

## Why

The customer-satisfaction percentage on the Reports page is a contractual WMRC KPI. Without the history, every council's trend restarts at zero on its cutover day, which reads as "no data" to WMRC for the better part of a year. Only 75 of the 1,080 surveys referenced a booking that exists in Verco — the rest are from before FY27 or from Stage-1 bookings that were given Verco refs — so requiring a booking would have meant importing almost none of them.

## What this changed from the original plan

The v2 design keyed every survey off a booking and derived council and month from it. Council now lives on the survey row itself, sub-client scoping for staff keys off that column, and the admin Surveys list, detail, export, dashboard feed and SLA card read it directly. The response-rate card counts Verco-native surveys only (imported rows are 100% submitted and would inflate it); the rating cards count everything. Legacy answers that don't map onto the current question set are kept verbatim under `legacy_*` keys and shown in the detail page's "Legacy" block.
