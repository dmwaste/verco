<!-- /autoplan restore point: /Users/danieltaylor/.gstack/projects/dmwaste-verco/claude-address-contractor-booking-edits-5fad52-autoplan-restore-20260828-142344.md -->
# ID Booking Edit — Design

**Date:** 2026-08-28 · **Branch:** `claude/address-contractor-booking-edits-5fad52` · **Status:** Under review (/autoplan — CEO phase complete)

## Problem

Illegal Dumping bookings are created once (field ranger form or admin office intake) and their ID-specific fields can never be corrected. Real case: VIN-YVMSIN was logged with `geo_address` "Front gate (Vincent works depot)" instead of the actual site "1 Linwood Court, Osborne Park" (data corrected manually 28/08). Staff had no self-service way to fix it; the pin was right but the label was wrong, and the label is what council staff see on the admin ID list and booking detail.

The generic Collection Details editor (pencil on `/admin/bookings/[id]`) already covers **Location, Collection Date, Notes** for ID bookings via `canEditCollectionDetails`. The gap is exactly the ID-only fields: `geo_address` + `latitude`/`longitude`, `id_waste_types`, `id_volume`, `photos` — all render-only today.

**Frequency evidence (queried 28/08):** 44 ID bookings since go-live 03/07/2026; exactly 1 identity-field correction ever (VIN-YVMSIN, manual SQL by Dan). Low frequency, structurally suppressed — no self-service path existed, so errors either stayed wrong or escalated to the MD. This calibrates scope: ship the correction path with evidence discipline; do NOT build approval workflows, reason-code taxonomies, or council notification plumbing until volume justifies them.

**Success metric:** zero manual-SQL data fixes on ID bookings after ship; corrections observable in `audit_log` (baseline 1 manual fix / 2 months).

## User decisions (settled in brainstorm, 28/08; premises reconfirmed at /autoplan gate)

1. **Field scope:** address (with re-geocode), waste types, volume editable; **photos append-only** (add, never remove — evidence integrity for council enforcement).
2. **Role gate:** **contractor-only at every status** (contractor-admin / contractor-staff). Client-tier admins keep the existing Location/Date/Notes editing but the ID fields stay read-only for them — a council cannot restate what was dumped or where.

## Design

### Gate

New `canEditIdDetails(status, role)` in `src/lib/booking/collection-details-edit.ts`:

```ts
canEditIdDetails = isContractorStaff(role) && canEditCollectionDetails(status, role)
```

Effective statuses: Pending Payment / Submitted / Confirmed / Scheduled / Completed — contractor roles only at all of them (client-tier passes `canEditCollectionDetails` pre-dispatch but fails `isContractorStaff`). Shared by UI, server action, and DB trigger so the three can't drift (same pattern as the existing gate). Terminal/exception statuses (Cancelled, Non-conformance, Nothing Presented, Rebooked) are deliberately NOT editable — NCN/NP records own their lifecycle via the dedicated rebook flow, and Cancelled bookings are dead records.

**UC1 resolved (Dan, 28/08): Completed edits stay UNBOUNDED** — the reviewers' time-box/amended-flag recommendation was presented with full cross-model context and declined; contractor-only + full audit trail is the accepted trust model. The trigger's status predicate = exactly these 5 statuses (terminal/exception statuses still excluded).

### Server action

`updateIdDetails(bookingId, data)` in `src/app/(admin)/admin/bookings/[id]/actions.ts`:

1. `current_user_role()` must be contractor-tier (explicit check, not just STAFF_ROLES).
2. Fetch booking under the caller's RLS (tenancy proof); assert `type = 'Illegal Dumping'` and `canEditIdDetails(status, role)` — the ACTION enforces the terminal-status exclusion too (tested at this layer, not just the pure helper).
3. Zod-validate input deriving from `idIntakeSchema` via `.pick().extend(...)`: pin pair becomes `nullable()` with a both-null-or-both-set refine (booking lat/lng are nullable — a bare `.pick()` would make every pinless-booking save fail zod); `geo_address` tightened to `trim().min(1).max(500)` (the intake schema allows empty — office intake tightens the same way); waste-type validation = every element either in `ID_WASTE_TYPES` **or already present on the stored row** (legacy/renamed tags stay saveable if untouched — memory `service-name-rename-gotcha`); volume refine unchanged, and the UI force-selects a volume when the stored value is NULL (legacy rows). Photo URL storage-bucket allowlist `isAllowedPhotoUrl` as-is; photo cap stays 20 (a *total*-stored cap — conscious decision at current volume; raise when first hit).
4. **Photos append-only enforced server-side:** photo arrays are normalised to unique URLs on write (dedupe); the new set must contain every stored URL (set-superset). Same semantics as the DB trigger's `NEW.photos @> OLD.photos` — the two layers use one definition (set containment over deduped arrays) so they cannot disagree on multiplicity edge cases.
5. **Optimistic concurrency guard:** the client submits the `updated_at` it rendered as an **opaque string, passed verbatim** — never through `new Date()` (Postgres keeps microseconds; JS truncates to milliseconds, and a re-formatted token would zero-row-match on EVERY save, a total silent outage no mocked test catches). The UPDATE carries `.eq('updated_at', seen)`; zero rows → "This booking changed while you were editing — reload and retry." The action returns the new `updated_at` so an immediate re-edit doesn't false-conflict before `router.refresh()` lands. CAS happy-path is covered by a pg-level test through real PostgREST, not only the conflict case.
6. No-op skip (compare all **six** columns: `geo_address, latitude, longitude, id_waste_types, id_volume, photos`; `id_waste_types` compared order-insensitively so tile-render order never triggers phantom writes).
7. Update the six columns with chained `.select()` so silent RLS/trigger rejection fails loud; trigger exceptions surface `error.message` verbatim.

No resident notification: ID bookings have no resident contact (`contact_id` null; ID skips resident notifications by design — memory `id-contact-link-and-notification-guard`).

**Billing note (refutes reviewer concern):** `id_volume` is an estimate; billable ID volume is confirmed by the crew at closeout (memory `id-volume-estimate-closeout-billing`). Editing the estimate moves no money.

### UI

Extends the existing Collection Details editor in `booking-detail-client.tsx` (no new page). The ID edit state is a **named sub-group — "Illegal Dumping Details"** — rendered ABOVE the generic Location/Date/Notes inputs in the edit branch, mirroring the read view (address is row one) and the correcting-under-pressure journey. Order inside the group: address search + crew-facing label + pin readout → waste-type tiles → volume tiles → evidence photos → then the generic fields, then Save/Cancel.

**Two-field address pattern (matches the intake idiom and the shared component's API):** `AddressAutocomplete` (`src/components/booking/address-autocomplete.tsx` — already shared, used by 3 surfaces) is an uncontrolled search box reporting only `onSelect(placeId, description)`. The edit branch therefore uses the intake's two-field pattern verbatim: the autocomplete as a *search* box that seeds/repins, plus a separate visible-label Input holding the persisted `geo_address` ("Location description shown to the crew"). Free-typed text edits the label input; only a prediction selection re-geocodes (place_id → lat/lng) and moves the pin. No changes to the shared component (its blast radius includes the public /book flow).

- **Pin readout:** the intake's existing status strip pattern (`Location pinned · {lat}, {lng}` / `Pinning location…`), semantic status tokens only (`bg-status-*-bg text-status-*` — never stock Tailwind ambers, per `docs/admin-design-system.md`). **Null-pin state:** "No pin set — crews rely on the description"; the pin-stale confirm is suppressed for pinless bookings (a persistent warn row shows instead).
- **Geocode in flight:** Save disabled while a re-geocode is pending (the intake needed `geocodeSeqRef` for exactly this race; reuse the pattern).
- **Pin-stale confirm (closes the loop VIN-YVMSIN opened):** if the label changed materially — trim + collapse-whitespace + case-insensitive compare, so cosmetic cleanups never cry wolf — AND the pin did not move, Save opens a blocking confirm dialog (focus moves to it, Escape cancels): "You changed the address but kept the existing map pin. Crews are routed by the pin." Actions: **"Keep pin & save"** / **"Back — pick an address to move the pin"**. For non-addressable sites with a wrong pin (no prediction exists), the dialog's accepted limitation is stated in copy: repinning needs an address selection; a wrong pin at an unaddressable site remains an ops call (mini-map/manual coords deferred — Decision #14).
- **Area-consistency warn — inline at input time, not on save** (matches the intake's own idiom): when a prediction repins, run `suggestAreaForAddress` (`id-area-suggestion.ts`, soft verdict, warn-never-block by design); on `mismatch` render an inline warn row: "This address looks like it belongs to {area}. Cross-area corrections need cancel + re-log." Save stays enabled; at most ONE interruption (the pin-stale confirm) can occur at Save.
- **Waste-type + volume as the intake's aria-pressed tile buttons** (not Select) — control parity with the sibling chips and with the intake for the same fields, and volume tiles reproduce the exact stored composite `"${label} (${sub})"` format, avoiding a silent value-format mismatch on round-trip.
- **Photos — three-state affordance:** persisted photos render with NO remove control and an "Evidence" lock treatment; photos added in THIS session are removable until Save (not yet stored — superset check permits); per-file upload failures render as error chips without dropping sibling files. The uploader ALWAYS renders in the edit branch (a photoless booking must be able to gain its first photo, even though the read view hides the empty section). Save is disabled while any upload is in flight. Wrong-photo-on-wrong-booking has no remedy by design (premise P3) — the lock treatment's title text says corrections happen by adding, never removing.
- **Client-tier rendering (mixed permissions):** a client-admin editing pre-dispatch sees the generic fields editable and the ID fields as read-only rows inside the edit branch with one caption — "Illegal dumping details can only be changed by D&M" — never disabled controls (invites "why can't I?" tickets) and never omission (reads as data loss).
- **Save result — inline `role="status"` banner** (the card's established idiom; no toast primitive exists on this page), status-conditional copy: Confirmed pre-stops → "Saved."; Scheduled → "Saved. The crew's stop updates on the next hourly sync." plus, when the collection date is today, "— today's route is already dispatched; phone ops for same-day corrections"; Completed → "Saved — record updated." (terminal stops are deliberately never touched).
- **Save architecture:** `handleSaveDetails` on ID bookings calls `updateIdDetails` FIRST (its `updated_at` CAS token is the page-render value and is only valid before sibling writes bump the trigger-maintained `updated_at`), then `updateNotes` → `updateCollectionDetails` as today; the chain stops at the first failure with the existing banner. A CAS conflict aborts the whole chain (nothing committed) with copy that warns the reload discards the draft.

### Dispatch (no new code — verified)

The hourly push EF is a reconciler: `payloadDiffers()` (`supabase/functions/_shared/stops.ts:204`) already compares `address`, `latitude`, `longitude` against the booking-derived desired stop, and `planStopChanges` refreshes any `Pending` stop while leaving terminal stops alone. An address edit therefore re-dispatches to OptimoRoute on the next hourly run with zero new sync code.

**Real guarantee, stated precisely:** edits made before the evening OR route download (~8pm, ADR 0018) reach the crew's planned route. Edits made after the crew has its route update the OR order and the Verco field PWA card (live RSC data), but OR's route *sequencing* was planned on the old pin. Same-morning corrections should be phoned through to ops as today. Covered by a unit test so the reconciler behaviour can't regress.

### Defence in depth — DB trigger

`booking_staff_update` RLS has no column or status restriction, so "contractor-only" would otherwise live only in a server action — one refactor from evaporating, on the record councils use as illegal-dumping evidence. New trigger `enforce_booking_id_fields_write` (BEFORE UPDATE ON booking):

- **Short-circuit ordering is load-bearing:** the FIRST check is column-change + type — exit unless `OLD.type = 'Illegal Dumping'` (OLD, not NEW — type is caller-suppliable on the same UPDATE) AND one of the six columns is `IS DISTINCT FROM`-changing. Every ID closeout is a `booking` UPDATE by the `field` role and every cancellation a client-staff UPDATE; if the role check ran first, crews would fail at 6am on every ID closeout (the 2am-Friday break — explicitly smoke-tested below).
- **Privileged pass-through uses the `collection_stop` trigger's exact pattern** (`20260610010100`): `v_claims IS NULL OR v_claims->>'role' = 'service_role'` → pass untouched. NOT the NULL-role-passes shorthand and NOT a claims-only check that rejects claims-NULL sessions — `supabase db query --linked` repair and pg_cron-context writes have NULL claims, and the manual-repair escape hatch must keep working the day it's needed. The repo's two divergent precedents make this exact-pattern mandate necessary.
- Otherwise: require contractor-tier role (NULL-safe: `(current_user_role() IN ('contractor-admin','contractor-staff')) IS NOT TRUE` → RAISE), require `OLD.status` in the editable set (same statuses as `canEditIdDetails` — without this the trigger would let a contractor JWT restate evidence on Cancelled/NCN/NP records via raw PostgREST, exactly the contested-record class; the status is on the row, zero extra lookups), and require `photos` append-only (`NEW.photos @> OLD.photos` over deduped arrays — single definition shared with the action).
- Non-ID bookings: unrestricted (other flows write `geo_address`/lat/lng).
- Mirrors ADR 0012's trigger-not-RLS choice (per-row lookups in `USING` are the initplan-timeout class; a BEFORE-UPDATE trigger fires only on writes).

Migration is additive-only (CREATE FUNCTION + CREATE TRIGGER), no schema change → no type regen, no Types-Freshness split; single-PR ship. Rollback = `DROP TRIGGER` migration + git revert.

### Audit

**No `field-labels.ts` changes at all** — eng review verified ALL FOUR labels already exist (`geo_address: 'Location (GPS)'` :39, `photos: 'Photos'`, `id_waste_types: 'Waste Types'`, `id_volume: 'Estimated Volume'` :40-42). Do not rename `photos` → "Evidence Photos": the map is keyed by column name globally and `non_conformance_notice.photos` shares the key.

**The real audit gap (HIGH, eng finding):** the live `audit_trigger_fn` (`20260515053849:58-61`) strips `photos` from BOTH sides of every diff — so a photos-only append would write an audit row rendering as an empty "Updated booking", and "who added this photo, when" (the exact enforcement question) would be unanswerable. This falsifies the plan's evidence claim unless fixed. **In scope:** a migration replacing `audit_trigger_fn` to stop stripping `photos` (keep stripping `geom`) — the column holds text URLs (≤20 × ~120 chars), not blobs, so row-size is a non-issue; NCN/NP photo evidence gains the same trail for free. The E2E asserts the PHOTO change specifically appears in the timeline (a photos-only save — an address change in the same save would make "an entry exists" pass vacuously).

## Out of scope

- Photo deletion (evidence integrity — deliberate; premise P3 reconfirmed).
- Client-tier access to ID fields (deliberate; premise P4 reconfirmed).
- Changing collection area (moves tenancy + capacity) — cross-area corrections go through cancel + re-log; the area-consistency warn routes staff there.
- Collection date / location / notes editing (already shipped, `updateCollectionDetails`).
- Field-surface (PWA) editing and field-form capture affordances — see User Challenge 2 at the gate.
- Approval workflows, reason codes, council notifications, original-intake snapshots — disproportionate at 1 correction / 2 months; revisit when correction volume or a council contract demands it (logged in Dream State).

## What already exists (leverage map — verified against tree 28/08)

| Sub-problem | Existing code |
|---|---|
| Status/role gate | `canEditCollectionDetails` + `isContractorStaff` (`collection-details-edit.ts`) |
| Validation | `idIntakeSchema` (`.pick()` from it), `isAllowedPhotoUrl`, `ID_WASTE_TYPES`, `ID_VOLUMES` |
| Address autocomplete + geocode | `google-places-proxy` EF (WA bias, place_id geocode mode) |
| Area consistency | `suggestAreaForAddress` (`id-area-suggestion.ts`) — soft verdict, built for exactly this |
| Photo upload | intake form's uploader → `ID_PHOTOS_BUCKET` |
| OR re-dispatch | `payloadDiffers`/`planStopChanges` reconciler (hourly push EF) |
| Audit | `audit_trigger_fn` on booking + `<AuditTimeline>`; `geo_address` label pre-exists |
| Editor UI shell | Collection Details card edit branch in `booking-detail-client.tsx` |

## Dream state delta

CURRENT: ID bookings write-once; corrections = MD running SQL. THIS PLAN: contractor self-service corrections, audited, evidence append-only, auto re-dispatch, capture-time pin visibility on the admin intake. 12-MONTH IDEAL: zero manual SQL fixes anywhere; "correction-annotated evidence" story sellable to councils (amended-after-completion flags, original-intake snapshots) — both reviewers agree that is the real competitive surface; this plan builds ~70% of it and the audit substrate the rest needs.

## Tests

- Gate matrix: `canEditIdDetails` — 5 editable statuses × 8 roles (+ null role), asserts contractor-only everywhere; terminal statuses rejected for all roles.
- Server action: photo-set-superset rejection (incl. duplicate-URL normalisation case), non-ID booking rejection, non-contractor rejection, **terminal-status rejection at the ACTION layer** (proves the helper is wired in, not just pure), zod rejections (bad waste type, bad volume, foreign photo URL), **pinless-booking save accepted** (nullable pin pair), legacy-tag pass-through accepted, no-op skip incl. reordered `id_waste_types`, concurrency-guard conflict (stale `updated_at` → error, no write).
- CAS integrity: **happy-path CAS through real PostgREST** (pg-level, catches the microsecond-truncation total-outage class that mocked clients can't) + conflict case.
- Dispatch regression: `payloadDiffers` true on address/lat/lng change; `planStopChanges` refreshes Pending, leaves Completed/Cancelled stops alone.
- Trigger pg smoke (rls.test.ts pattern): client-admin write to ID columns rejected; **`field` role closeout (`status='Completed'`) on an ID booking ALLOWED** (the 2am-Friday regression); **client-staff cancellation (status+cancelled_at) on an ID booking ALLOWED**; `field` role writing `photos`/`id_volume` rejected; contractor write allowed on editable statuses; **contractor write on a Cancelled/NCN booking REJECTED** (status predicate); photo-removal rejected even for contractor; service-role bypass intact; **claims-NULL direct-SQL session passes** (repair path); non-ID booking writes unaffected.
- Audit: photos-only append produces an audit row whose diff CONTAINS the photos change (post-`audit_trigger_fn` fix).
- UI: pin-stale confirm appears exactly when label changed materially + pin unchanged (and is suppressed on pinless bookings); area-mismatch warn renders on `mismatch` verdict; per-file upload failure surfaces without dropping other files; volume force-select on NULL-volume rows.
- E2E: contractor corrects a Scheduled ID booking's address via autocomplete + adds a photo; asserts pin readout updated, saved values, and the photo change visible in the audit timeline.

## Error & Rescue Registry

```
METHOD/CODEPATH                  | WHAT CAN GO WRONG                       | HANDLED / USER SEES
---------------------------------|------------------------------------------|--------------------------------------------
updateIdDetails role fetch       | RPC error / NULL role                    | reject "Insufficient permissions."
updateIdDetails booking fetch    | not found / RLS-hidden                   | reject "Booking not found."
updateIdDetails zod parse        | any invalid field                        | first issue message returned verbatim
updateIdDetails UPDATE           | RLS silent reject                        | chained .select() → explicit error
                                 | trigger rejection (role/photos)          | error.message from Postgres, shown in banner
                                 | stale updated_at (concurrent edit)       | 0 rows → "booking changed — reload"
google-places-proxy autocomplete | EF down / Google error                   | predictions empty + error field; free-text still works
google-places-proxy geocode      | place_id fails / ZERO_RESULTS            | pin unchanged; pin-stale confirm still guards save
photo upload (client)            | one file fails of N                      | per-file error chip; others proceed; failed URL never submitted
                                 | user navigates away mid-upload           | orphan object in ID_PHOTOS_BUCKET (same as intake today — accepted)
push EF reconcile                | OR API down at next hourly run           | existing EF retry/500 semantics; stop refreshes on the following run
```

No silent failures: every rejection path returns a named message rendered in the existing card error banner; Sentry captures thrown action errors (existing wiring).

## Failure Modes Registry

```
CODEPATH                  | FAILURE MODE                    | RESCUED? | TEST? | USER SEES?              | LOGGED?
--------------------------|---------------------------------|----------|-------|-------------------------|--------
updateIdDetails           | non-contractor write            | Y        | Y     | permission error        | audit(no-op)
updateIdDetails           | photo removal attempt           | Y        | Y     | explicit rejection      | Sentry
updateIdDetails           | concurrent edit clobber         | Y        | Y     | reload prompt           | —
booking UPDATE (any path) | app-layer gate refactored away  | Y (trig) | Y     | Postgres error          | audit
edit UI                   | label fixed, pin stale          | Y (confirm)| Y   | explicit confirm        | audit shows no lat/lng change
edit UI                   | pin moved into wrong area       | WARN     | Y     | area-mismatch warning   | audit
OR dispatch               | edit after route download       | PARTIAL  | Y     | toast states guarantee  | completion_synced_at
```

No CRITICAL GAP rows (RESCUED=N + TEST=N + silent): the edit-after-route-download case is inherent to the dispatch architecture (ADR 0018), disclosed in the UI, and matches today's operational reality.

## CEO Review — Section Findings (Phase 1, /autoplan)

- **S1 Architecture:** New coupling: booking-detail editor → places component → EF (already exists for intake); trigger couples DB to role helpers (existing pattern). SPOF: google-places-proxy — degraded, not broken (free-text). 10x/100x load: n/a (admin surface, tens of edits/yr). Rollback: revert + DROP TRIGGER. 1 issue found (pin-stale flaw) → fixed in design.
- **S2 Errors:** registry above; 1 gap found (uploader per-file failure surfacing) → now specified + tested.
- **S3 Security:** attack surface = 1 network-callable server action; authz = role gate + RLS tenancy + DB trigger; photo `src` allowlist prevents foreign-origin injection; no PII (contact-less bookings); audit trail on. 0 open issues, 0 High.
- **S4 Data/UX edges:** double-click (isPending), stale concurrent edit (guard added), navigate-away upload orphan (accepted, documented), EF-down mid-edit (pin guard covers). 4 mapped, 0 unhandled.
- **S5 Quality:** schema derived via `.pick()` not re-typed; field-labels collision caught (geo_address pre-exists — don't relabel); trigger short-circuit ordering specified. 3 issues → all folded in.
- **S6 Tests:** diagram = Tests section; 2am-Friday test = pg smoke proving client-admin PostgREST writes rejected; hostile-QA test = photo-removal + foreign-URL; flakiness: none time/random-dependent.
- **S7 Performance:** trigger short-circuits before any helper call; no new queries on read paths; no indexes needed. 0 issues.
- **S8 Observability:** audit_log is the trail; Sentry on action errors; success metric defined (manual-SQL fixes → 0). 0 gaps.
- **S9 Deploy:** additive migration, no type regen, single PR; no old-code/new-trigger hazard (nothing else user-writes these columns); post-deploy check: edit a staging ID booking + confirm audit row. 0 risks flagged.
- **S10 Trajectory:** reversibility 4/5; debt: none new (T1 decides extraction); pattern established for per-type field gates; 1-year legibility via gate helper doc comments.
- **S11 Design/UX:** state coverage LOADING/EMPTY/ERROR/SUCCESS/PARTIAL specified; hierarchy: address+pin → waste → volume → photos; a11y: aria-pressed chips, keyboard uploader, existing focus-ring base. Deep pass in Phase 2.

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Skip WebSearch landscape check | Mechanical | P3 | Internal correction affordance; landscape = chain-of-custody convention already applied | live search |
| 2 | CEO | Approach A (extend editor + trigger) | Mechanical | P1,P5 | Complete + explicit; C = premature abstraction | B, C |
| 3 | CEO | Add pin-stale save confirm | Mechanical | P1 | Free-typed correction would fix label, strand pin — worse than original bug | block-save (heavier) |
| 4 | CEO | Add area-consistency warn (never block) | Mechanical | P2,P4 | id-area-suggestion exists, built for this; in blast radius | blocking gate |
| 5 | CEO | Don't relabel geo_address; add 3 labels | Mechanical | P3 | Column shared with non-ID flows; label pre-exists | relabel to "Address" |
| 6 | CEO | Single append-only definition (deduped set-superset) both layers | Mechanical | P5 | @> multiplicity edge would let layers disagree | multiset semantics in SQL |
| 7 | CEO | Add optimistic concurrency guard (updated_at CAS) | Mechanical | P1 | Evidence fields; cheap; mirrors #387.1 lesson | last-write-wins |
| 8 | CEO | State real dispatch guarantee in toast/plan | Mechanical | P5 | "Within the hour" overstated post-route-download edits | vague copy |
| 9 | CEO | Frequency evidence queried + in plan (1/44/2mo) | Mechanical | P6 | Both voices demanded it; data settles proportionality | assert without data |
| 10 | CEO | No approval workflow / reason codes / council notify now | Mechanical | P3,P6 | 1 correction per 2 months; revisit trigger documented | evidence-grade cathedral now |
| 11 | CEO | id_volume billing concern refuted | Mechanical | P6 | Closeout owns billable volume (memory) | billing review flow |
| 12 | CEO | Terminal statuses stay non-editable | Mechanical | P3 | NCN/NP own their lifecycle; Cancelled is dead | extending gate |
| 13 | CEO | ~~Admin-intake pin readout expansion~~ STRUCK | Corrected | — | Design review found the intake already ships this (`id-request-form.tsx:390-411`, since #164) — the "expansion" was shipped code | — |
| 14 | CEO | Mini-map preview / manual coords | Deferred | P3 | Leaflet weight for taste payoff; limitation now stated in confirm-dialog copy | build now |
| 15 | CEO | PWA field-surface corrections | Deferred → UC2 | — | Field-contract change class (03/08 outage); both models want capture-side | — |
| 16 | CEO | ~~Places extraction (T1)~~ RESOLVED — no extraction exists to do | Corrected | P4 | `src/components/booking/address-autocomplete.tsx` already shared by 3 surfaces; edit branch consumes it as-is; intake form untouched | modify shared component |
| 17 | CEO | Completed-edit time-box/amended-flag | USER CHALLENGE → gate (UC1) | — | Both models challenge "every status, unbounded" | — |
| 18 | Design | Skip AI mockup generation | Mechanical | P4,P5 | In-place extension of checked-in admin card idiom; mockups would invent parallel design | generate variants |
| 19 | Design | Named "Illegal Dumping Details" sub-group, address-first order | Mechanical (both voices) | P5 | Read view + correction journey lead with address; burying it 4th serves the implementer | append after Notes |
| 20 | Design | Two-field address pattern (search + crew label) | Mechanical (verified API) | P4,P5 | `AddressAutocomplete` has no controlled-value surface; intake pattern exists | modify shared component |
| 21 | Design | `updateIdDetails` first in save chain; CAS aborts whole chain | Mechanical (both voices) | P1 | `booking_updated_at` trigger bumps on every write — CAS after sibling writes fails 100% | separate Save button |
| 22 | Design | Area warn inline at repin time, not on save | Mechanical (both voices) | P5 | Matches intake idiom; leaves Save one interruption max | on-save warning |
| 23 | Design | Volume/waste as intake tile buttons, composite value format | Mechanical | P4 | Control + value-format parity; Select invited silent mismatch | Select |
| 24 | Design | Photos three-state affordance (locked/session-removable/error chips), uploader always rendered | Mechanical (both voices) | P1 | Reused intake grid would ship remove buttons that only fail at the trigger | reuse grid as-is |
| 25 | Design | Client-tier sees read-only rows + caption | Mechanical | P5 | Disabled controls invite tickets; omission reads as data loss | disable/hide |
| 26 | Design | Inline role=status banner, status-conditional copy | Mechanical (both voices) | P5 | No toast primitive on page; "stop updates" is false for Confirmed/Completed | toast |
| 27 | Design | "Materially changed" = trim+collapse+case-insensitive | Mechanical | P5 | Naive !== trains staff to click through the one dialog that matters | exact compare |
| 28 | Design | Null-pin + geocode-in-flight + upload-in-flight states specified | Mechanical (both voices) | P1 | Unspecified states = implementer imagination on an evidence surface | leave to impl |

## Design Review — Pass Ratings (Phase 2, /autoplan)

Initial design completeness: **5/10** (operationally strong, UI was an ingredients list — states and layout left to the implementer). After auto-fixes: **9/10** (remaining point held by UC1's unresolved Completed-edit affordance).

| Pass | Rating | Outcome |
|---|---|---|
| 1 Information architecture | 4→9 | Named sub-group, address-first order specified (D19) |
| 2 Interaction state coverage | 4→9 | Null-pin, geocode-in-flight, upload-in-flight, partial failure, CAS-conflict draft-loss copy all specified (D21, D24, D28) |
| 3 User journey / emotional arc | 6→9 | Pressure journey leads the layout; false dispatch reassurance removed via status-conditional copy (D26); non-addressable-site limitation stated honestly in dialog copy |
| 4 AI slop risk | 8→9 | Extends checked-in card idiom; tile/chip/banner primitives reused; classifier: APP UI — calm hierarchy, no new decoration |
| 5 Design system alignment | 6→9 | Semantic status tokens mandated for warn/confirm/pin states; no stock Tailwind ambers (D28); NOTE: intake form's existing amber-* mismatch warn violates the system — flagged as out-of-scope repo issue |
| 6 Responsive & accessibility | 5→8 | Single-column form in the 2/3 card column; tiles wrap; 44px touch targets on tiles/uploader; confirm dialog focus-trap + Escape; aria-pressed tiles; role=status banner announced. Held from 9: the card's pencil affordance stays small (pre-existing, out of scope) |
| 7 Unresolved design decisions | — | ONE remains, deliberately: UC1 (Completed-edit affordance — amended badge / time-box) → final gate |

```
DESIGN DUAL VOICES — CONSENSUS (litmus):
═══════════════════════════════════════════════════════════════
  Dimension                          Claude   Codex    Consensus
  ─────────────────────────────────── ──────── ──────── ─────────
  1. Hierarchy serves the user?       NO→fix   NO→fix   CONFIRMED (fixed D19)
  2. States specified?                NO→fix   NO→fix   CONFIRMED (fixed D21/24/28)
  3. Save semantics sound?            NO→fix   NO→fix   CONFIRMED (fixed D21)
  4. Matches component APIs/idiom?    NO→fix   PARTIAL  CONFIRMED (fixed D20/23/26)
  5. Pin-stale confirm well-formed?   PARTIAL  PARTIAL  CONFIRMED (fixed D22/27 + dialog spec)
  6. Completed-edit affordance?       OPEN     OPEN     AGREE → UC1 at gate
  7. Capture-side parity?             OPEN     OPEN     AGREE → UC2 at gate
═══════════════════════════════════════════════════════════════
```

## Eng Review — Phase 3 (/autoplan) [subagent-only — Codex usage-limited mid-pipeline]

### Architecture (system diagram)

```
                         ┌─ admin booking detail page ─────────────────────┐
  contractor admin ────▶ │ booking-detail-client.tsx                       │
                         │  └ ID edit sub-group                            │
                         │     ├ AddressAutocomplete (existing, unchanged) ─┼──▶ google-places-proxy EF ──▶ Google
                         │     ├ crew-label Input + pin readout            │
                         │     ├ waste/volume tiles · photo uploader ──────┼──▶ Storage ID_PHOTOS_BUCKET
                         │     └ handleSaveDetails: updateIdDetails FIRST  │
                         └───────────────┬─────────────────────────────────┘
                                         ▼ (anon key, caller RLS)
                         updateIdDetails (actions.ts) ── zod(.pick().extend) ── CAS eq(updated_at)
                                         ▼ UPDATE booking (6 cols)
                    ┌────────────────────┼──────────────────────────┐
                    ▼                    ▼                          ▼
        enforce_booking_id_fields_write  booking_updated_at   audit_trigger_fn (fixed: keeps photos)
        (NEW trigger: type+cols → priv → role+status+photos@>)      ▼
                    │                                          audit_log ──▶ <AuditTimeline>
                    ▼ (hourly, no new code)
        push-orders-to-optimoroute ── payloadDiffers(addr,lat,lng) ──▶ refresh Pending stop ──▶ OptimoRoute
```

Coupling: no new component→component edges beyond the existing intake's; trigger couples DB to role helper (established ADR 0012 class). SPOF: places EF (degrades to free-text label editing). Verified sound by the independent subagent: dispatch reconciler claim, CAS-shields-photo-TOCTOU, save-chain ordering, gate composition, contact-less notification stance.

### Eng findings (11) — all folded into the sections above

| # | Sev (conf) | Finding | Resolution |
|---|---|---|---|
| E1 | HIGH (9) | `audit_trigger_fn` strips `photos` — evidence claim false | Migration keeps photos in diffs (§Audit) |
| E2 | HIGH (8) | Service-role detection ambiguous; two repo precedents diverge | `collection_stop` pattern mandated verbatim (§Trigger) |
| E3 | HIGH (8) | Trigger could break field closeouts / staff cancellations of ID bookings | Short-circuit ordering mandated + 3 smoke tests (§Tests) |
| E4 | MED-H (8) | `.pick()` non-nullable pin pair breaks pinless saves; empty geo_address allowed | `.extend()` nullable pair + refine + trim().min(1) (§Action step 3) |
| E5 | MED (8) | Trigger lacked status predicate — contractor could restate Cancelled/NCN evidence via PostgREST | `OLD.status` predicate added (§Trigger) |
| E6 | MED (7) | CAS token through `new Date()` = permanent false-conflict outage | Opaque-string mandate + real-PostgREST happy-path test (§Action step 5) |
| E7 | MED (9) | field-labels: all labels already exist; photos rename would leak into NCN/NP | No label changes at all (§Audit) |
| E8 | LOW (8) | "five columns" vs six; waste order-sensitivity | Fixed wording; order-insensitive compare (§Action step 6) |
| E9 | LOW (8) | photos max(20) is a total-stored cap | Conscious keep-at-20, raise when hit (§Action step 3) |
| E10 | LOW (7) | NULL volume / legacy waste tags make rows unsaveable | Force-select volume; stored-tag pass-through (§Action step 3) |
| E11 | LOW (6) | No terminal-status rejection test at action layer | Added (§Tests) |

```
ENG DUAL VOICES — CONSENSUS TABLE:
═══════════════════════════════════════════════════════════════
  Dimension                        Claude   Codex   Consensus
  ────────────────────────────────── ──────── ─────── ──────────
  1. Architecture sound?            YES      N/A     [subagent-only]
  2. Test coverage sufficient?      NO→fixed N/A     fixed (E3/E6/E11 + audit E2E)
  3. Performance risks addressed?   YES      N/A     [subagent-only]
  4. Security threats covered?      NO→fixed N/A     fixed (E2/E5; field-role writer class named)
  5. Error paths handled?           NO→fixed N/A     fixed (E4/E6/E10)
  6. Deployment risk manageable?    YES      N/A     [subagent-only]
═══════════════════════════════════════════════════════════════
Codex CLI usage-limited after CEO+Design phases (resets 21/09) — eng outside
voice degraded to the independent Claude subagent per the degradation matrix.
```

### Test coverage diagram

```
CODE PATHS                                              USER FLOWS
[+] collection-details-edit.ts::canEditIdDetails        [+] Correct a Scheduled ID address
  └── [PLANNED ★★★] 5 statuses × 9 roles + terminals      ├── [PLANNED ★★★→E2E] autocomplete→repin→save→audit
[+] actions.ts::updateIdDetails                           ├── [PLANNED ★★] free-type label → confirm dialog
  ├── [PLANNED ★★★] role/type/status/zod rejections       └── [PLANNED ★★] add photo to photoless booking
  ├── [PLANNED ★★★] photo superset + dedupe             [+] Concurrency
  ├── [PLANNED ★★★] CAS happy (pg) + conflict             └── [PLANNED ★★] two admins, stale token → reload
  └── [PLANNED ★★] no-op skip (6 cols, order-insens.)   [+] Field crew (regression class)
[+] trigger enforce_booking_id_fields_write               ├── [PLANNED ★★★] ID closeout still works
  ├── [PLANNED ★★★] role/status/photos rejections         └── [PLANNED ★★★] staff cancellation still works
  ├── [PLANNED ★★★] privileged pass (service+claims-NULL)
  └── [PLANNED ★★] non-ID unaffected                    LLM/EVAL: none (no prompt surface)
[+] _shared/stops.ts (existing, regression only)
  └── [PLANNED ★★★] payloadDiffers/planStopChanges
COVERAGE TARGET: every branch above has a planned test — 0 GAPS accepted at plan stage
```

### Performance
Trigger short-circuits on column-diff before any helper call; zero new read-path queries; no indexes needed (writes keyed by PK); places EF calls are user-initiated only. No issues.

### Parallelization
Sequential implementation, no parallelization opportunity — every workstream converges on `booking-detail-client.tsx` + `actions.ts`; the migration is a 30-minute prefix step, not a lane.

### Deploy
Order: migration (trigger + audit_trigger_fn fix, additive, no schema/type change) → app deploy; single PR to develop; no Types-Freshness split; rollback = DROP TRIGGER + restore prior audit_trigger_fn + git revert. Post-deploy check: staging ID booking edit → audit row shows photo diff.

## Final Gate Resolutions (Dan, 28/08)

| # | Decision | Outcome |
|---|----------|---------|
| 29 | UC1 post-Completed bounds | **Unbounded, as originally directed** — user reaffirmed after full cross-model context; reviewers' concern recorded, not adopted |
| 30 | UC2 capture-side field-form guard | **TODO, separate field-surface PR** — logged in TODOS.md |
| 31 | Final approval | **APPROVED** — proceed to implementation |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (via /autoplan) | 31 voice findings → 12 folded, 2 user challenges resolved, 3 refuted with evidence |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | RAN (CEO+Design; quota-limited before Eng) | 20 strategy + 1 UX-verdict set |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (via /autoplan, subagent-only) | 11 issues (3 HIGH), 0 critical gaps open, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (via /autoplan) | score 5/10 → 9/10, 14 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | SKIPPED | no developer-facing scope |

CROSS-MODEL: strong overlap on evidence-record integrity, post-Completed bounds (declined by user), capture-side gap (deferred to TODO); Codex-only concerns on billing/config-governance refuted with repo evidence.
VERDICT: CEO + ENG + DESIGN CLEARED — ready to implement.
NO UNRESOLVED DECISIONS
