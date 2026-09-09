# Collection Type Marker (MUD / ID) for Crews — Design

**Date:** 2026-09-09 · **Branch:** `claude/collection-id-mud-classification-b0d141` · **Status:** Approved (plan-mode review, Dan 09/09)

## Problem

Crews work the stop-model run sheet (`/field/runs/[date]/[driver]`) and the per-stop closeout page. A MUD stop was marked only by a faint ` · MUD` text suffix on the ref line; an Illegal Dumping stop only by the red "Illegal Dumping" waste-stream chip, which sits in the same slot as "General"/"Green", reads as a pass label, and drops below the fold once the stop closes. A MUD general-pass stop was otherwise indistinguishable from a residential one. Crews didn't know they were pulling up to a 38-unit strata block or a ranger-logged dump site.

**No new data was needed.** `booking.type` (`Residential | MUD | Illegal Dumping | Call Back - DM | Call Back - Client`) is the canonical discriminator and every run-sheet consumer already joins it.

## Decisions (Dan, 09/09/2026)

1. **Surfaces:** crew stop cards + closeout header, admin run sheet detail (the ops print view), and the OptimoRoute order notes (a leading `Type:` line so ops see it while route-planning). The legacy `/field/run-sheet` is untouched (Phase-4 retirement).
2. **MUD marker carries the unit count** — "MUD · 38 units" — so the crew knows the block size to expect.
3. **Out of scope:** any migration or new `collection_stop` column; surfacing the strata's free-text waste-location notes on the card (separate gap, see Follow-ups).

## Design

### Job type is read at render / push time, never denormalised onto the stop

The schema's "stop never joins booking" rule (`20260610010100_collection_stop_schema.sql`) is a PII rule. `booking(type)` was already embedded by every consumer, and `eligible_properties` is public-SELECT with no PII. So:

- `src/lib/stops/run-sheet-data.ts` embeds `booking:booking_id(id, ref, status, type, property:property_id(unit_count))`; `RunStop.booking.property` is **required** (`{ unit_count } | null`, null for ID bookings which have no property) so a forgotten select edit can't hide behind a cast.
- The closeout page select gains the same `property:property_id(unit_count)`; `StopDetail.booking.property` mirrors it. A render test guards the header because the page casts.
- The push EF's Pass-2 booking re-join (already there for the resident email) also selects `type` and `property:property_id(unit_count)`. Nothing is added to `collection_stop`, `PendingStopRow`, or `payloadDiffers` — no refresh storm. Already-pushed orders pick the line up only when naturally refreshed.

Reviewed: `booking.property_id` is the only FK to `eligible_properties`; the `alias:property_id(...)` embed is live on five other surfaces; `eligible_properties_public_select` is InitPlan-hoisted and short-circuits TRUE for field users, so the nested embed is one PK lookup per stop.

### One mirrored helper owns the label rule

`supabase/functions/_shared/stops.ts` (mirror `src/lib/stops/stops.ts` via `scripts/sync-mirrors.sh`):

```ts
bookingTypeTag(type, unitCount): { code: 'MUD' | 'ID'; units: number | null } | null
orderTypeLine(tag): 'MUD (38 units)' | 'MUD' | 'Illegal Dumping' | null
buildOrderNotes(summary, location?, driverNotes?, typeLine?)   // Type: line FIRST
```

**`units` is set only when `unitCount >= 2` — load-bearing, not defensive.** `eligible_properties.unit_count` is `NOT NULL DEFAULT 1`, and migration `20260522143000_mud_relax_unit_count_constraint.sql` dropped the `>= 8` check with "unit_count=0 is valid and means not yet recorded". Both the crew badge and the OR note consume the one struct so the 0/1 rule cannot drift.

### `BookingTypeBadge` (`src/components/field/booking-type-badge.tsx`)

Modelled on `StreamBadge`: fixed hex tint pairs, not white-label vars, so it reads the same across tenants on multi-council days. Renders nothing for Residential / Call Back.

- MUD: `bg-[#F3EEFF] text-[#805AD5]` — the `PURPLE` pair in `lib/ui/status-styles.ts`, the admin `Pill` accent tone, and the bookings-list type dot.
- ID: `bg-[#FFF0F0] text-[#B42318]` — the `illegal_dumping` stream chip red, so red = illegal dumping everywhere on the field surface.
- `border border-current` so the pill still reads when the admin run sheet is printed and the browser drops background fills. On the admin table it is deliberately NOT `print:hidden`.
- No card left-border accent: one signal, and a conditional `border-l-4` would shift MUD/ID card content 4px against the rest of the list.

## Tests

- `src/__tests__/stops.test.ts` — `bookingTypeTag` (38 / 0 / 1 / null / ID / Residential / Call Back), `orderTypeLine`, `buildOrderNotes` Type-line ordering and omission.
- `src/__tests__/field/booking-type-badge.test.tsx` — the four render states.
- `src/__tests__/field/run-sheet-card-links.test.tsx` — MUD (with Enter Count), ID, Residential, cancelled-MUD cards.
- `src/__tests__/field/stop-closeout-type-badge.test.tsx` — header badge + caption no longer suffixed.
- `src/__tests__/field/admin-run-sheet-type-badge.test.tsx` — badge present and not inside a `print:hidden` ancestor.
- `src/__tests__/run-sheet-data.test.ts` — the shared select string.
- The push EF index has no unit harness (existing pattern: `_shared` helpers are the tested unit); its wiring is covered by CI `deno check`.

## Follow-ups (not in this change)

- **MUD waste-location notes never reach the run-sheet card**: `createMudBooking` stores the strata's free-text `waste_location_notes` in `booking.location`, but the push EF keeps only the four fixed placements (`wasteLocationOrNull`), so `collection_stop.waste_location` is NULL for MUDs and crews see those notes only on the closeout page.
- **ID closeout never confirms actual allocations**: `id-options.ts` says the intake volume is an estimate confirmed at closeout, but the `actual_services` gate is keyed strictly on `type === 'MUD'` (VER-260 still open).
