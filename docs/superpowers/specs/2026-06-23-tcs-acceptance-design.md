<!-- /autoplan restore point: ~/.gstack/projects/dmwaste-verco/claude-cool-swanson-0ee8f0-autoplan-restore-20260623-143537.md -->
# T&Cs Acceptance — Design Spec

**Date:** 2026-06-23
**Branch:** claude/cool-swanson-0ee8f0
**Status:** Approved design (brainstorming) → entering autoplan review

---

## Problem

WA councils require residents to accept program Terms & Conditions before a bulk
verge collection booking is confirmed. Today bookings are created with no consent
step. We need a per-client (per-council, NOT per-sub-client) T&Cs acceptance gate
that fires before a booking is created (and therefore before the confirmation
notification is sent), with the accepted terms recorded against the booking for a
defensible audit trail.

## Decisions locked in brainstorming

1. **Record acceptance on the booking** — store `terms_accepted_at` + a server-side
   snapshot of the exact terms text accepted (not just a UI gate).
2. **All booking paths** — resident self-serve, admin on-behalf, and MUD bookings all
   require acceptance. (Ranger illegal-dumping intake is excluded — no resident.)
3. **Skip when empty** — a client with no T&Cs text configured books normally (no
   popup). Data-driven rollout, fail-open on the client UX, like the WS-A `is_active`
   gate.
4. **Per-client, single markdown entry** — one T&Cs body per client, markdown like
   FAQs, but a single entry (one dialog box), edited in the Client config page.
5. **Reuse the FAQ markdown renderer** (`FaqAnswer`) — no `rehype-raw`, safe.

## Architecture

`category.code`-style overloading is avoided; this is a clean additive feature.

### Data model

- `client.terms_markdown text` (nullable) — the single per-client T&Cs entry, markdown.
  NULL/empty ⇒ no gate. `client` is already a public-SELECT table, so residents (anon)
  can read it for the dialog.
- `client.terms_version int NOT NULL DEFAULT 1` (D2) — bumped on each terms edit
  (in `updateClientTerms`). Snapshotted onto the booking so the record proves which
  published version was accepted.
- `booking.terms_accepted_at timestamptz` (nullable) — when accepted.
- `booking.terms_accepted_text text` (nullable) — server-snapshotted copy of the exact
  `client.terms_markdown` at creation time. Proves what was agreed.
- `booking.terms_version int` (nullable, D2) — the `client.terms_version` snapshotted at
  acceptance.
- `booking.terms_accepted_by uuid` (nullable, D1) — the acting user who accepted (the
  actor already threaded into the RPC). NULL for anonymous guest residents.
- `booking.terms_accepted_channel` (nullable enum `resident_self | staff_on_behalf | mud_admin`, D1)
  — distinguishes resident self-consent from a staff acknowledgement on the resident's
  behalf, so the record is honest in a dispute. Set by the RPC from the call path
  (resident/on-behalf EF vs MUD action) — not client-supplied.

All `booking.terms_*` columns are written server-side by the RPC; the caller supplies
only the boolean `p_terms_accepted` and (for channel) which path it is. Terms are short
and low-churn, so the full-text snapshot + version + acceptor is the defensible record
without a separate versioned-history table.

### Server enforcement + recording — single chokepoint

Both the resident/on-behalf path (via the `create-booking` Edge Function) and the MUD
path (`createMudBooking` server action) funnel through the
`create_booking_with_capacity_check` RPC. That RPC is the single recording chokepoint,
mirroring the WS-A go-live gate's defense-in-depth layering:

- **RPC** gains `p_terms_accepted boolean DEFAULT false`. It reads the client's
  `terms_markdown`; if non-empty **and** `p_terms_accepted` is not true → `RAISE`
  (fail-closed). If terms are empty → ignore (skip). When accepted, it sets
  `terms_accepted_at = now()` and `terms_accepted_text = <server-read terms_markdown>`
  on the inserted booking. **The text is read server-side from the client row — never
  supplied by the caller** (same "never trust the client" stance as pricing).
- **`create-booking` EF** passes `terms_accepted` through to the RPC and can also 403
  early with a clear message (mirrors `isAreaBookableServer`). For the in-place
  edit/update path (existing booking), terms re-acceptance is NOT required (the booking
  already has an acceptance record; editing services doesn't re-trigger consent).
- **`createMudBooking` action** passes `p_terms_accepted` through to the same RPC.
- **RLS** `booking_resident_insert` is not the recording layer (it can't snapshot text).
  CORRECTION (Eng review F1): `create_booking_with_capacity_check` is **SECURITY
  INVOKER**, not DEFINER. The resident path reaches it via the EF's service-role client
  (bypasses RLS); the MUD path reaches it via the user session. So "the RPC owns the
  write because it's DEFINER" is wrong.
  **RLS bypass to close (Eng review F2 — critical, mirrors WS-A):** `booking_resident_insert`
  currently lets an authenticated resident/strata user `INSERT` a booking *directly* via
  PostgREST, skipping the RPC — and therefore skipping terms enforcement AND recording.
  No app code does this today, but Red Line #7 forbids leaving the contract open. Fix:
  add a `WITH CHECK` term `AND (NOT public.client_has_terms(client_id) OR terms_accepted_at IS NOT NULL)`,
  backed by a SECURITY DEFINER `client_has_terms(uuid)` helper that fails closed. The RPC
  (which sets `terms_accepted_at`) still passes; a forged direct insert into a
  terms-enabled client is rejected.

### Admin editing

New **"Terms & Conditions" tab** on the client config detail page (`clients/[id]`),
mirroring the FAQs tab exactly but for a single entry:

- A single markdown `<textarea>` + live `<FaqAnswer markdown={...}>` preview + Save.
- Saved via a new `updateClientTerms(clientId, markdown)` server action (mirrors
  `updateClientFaqs`), contractor-admin/staff scoped like other client-config writes.
- Audit: `client` already has the audit trigger; add `terms_markdown` to
  `lib/audit/field-labels.ts`.

### Resident / on-behalf dialog (`confirm-form.tsx`)

- Fetch `client.terms_markdown` client-side (the confirm-form already fetches
  `client.service_name` via the `collection_area → client` embed — extend that single
  query to also select `terms_markdown`). Mockable in E2E.
- When the user clicks **Confirm Booking / Proceed to Payment**, if terms are non-empty,
  open a modal rendering the markdown (via `FaqAnswer`) with a required "I have read and
  accept the Terms & Conditions" checkbox. Only on accept does `submitBooking()` proceed,
  sending `terms_accepted: true` in the create-booking body. Empty terms ⇒ no modal,
  current behaviour.
- On-behalf (staff, `on_behalf=true`) uses the same confirm-form, so it inherits the
  dialog; the staff member acknowledges on the resident's behalf.

### MUD dialog (`mud-booking-form.tsx`)

- Same acceptance modal before the staff submits the MUD booking; passes
  `terms_accepted: true` into `createMudBooking`.

### Markdown rendering

Reuse `components/faq-answer.tsx` (react-markdown, directive-free, `tel:` urlTransform,
no `rehype-raw`). No new renderer. T&Cs are admin-authored multi-tenant content on a
public surface, so raw HTML must stay inert — the existing renderer already guarantees
this.

## Edge cases

- Empty/NULL terms ⇒ gate skipped everywhere (client UX, EF, RPC). Per-client rollout by
  filling in the text when ready.
- ID/illegal-dumping intake (`create_id_booking_with_capacity_check`) — excluded (ranger
  created, no resident consenting).
- Sub-clients — T&Cs are at the **client** level only; a sub-client-scoped booking uses
  its parent client's terms.
- In-place service edits (admin "Edit services") — no re-acceptance; the original
  acceptance stands.
- Terms changed after a booking — historical bookings keep their snapshot; only new
  bookings see the new text.

## Testing

- **Unit (RPC behaviour, pgTAP-style or via the rolled-back-transaction pattern):**
  - terms set + `p_terms_accepted=false` ⇒ RAISE (rejected).
  - terms set + `p_terms_accepted=true` ⇒ booking created with `terms_accepted_at` set
    and `terms_accepted_text` == client's `terms_markdown`.
  - terms empty ⇒ booking created regardless of the flag, `terms_accepted_*` NULL.
- **Unit (helpers):** any pure helper added (e.g. `clientHasTerms(markdown)`).
- **E2E (`booking-flow.spec.ts`):**
  - client with terms ⇒ confirm shows the T&Cs modal; accept ⇒ booking confirms.
  - client without terms ⇒ no modal, booking confirms (regression guard).
  - the E2E mock returns a `client.terms_markdown` for the terms case and empty for the
    no-terms case.
- **Admin:** updateClientTerms round-trips; preview renders markdown.

## Out of scope

- Versioned terms history / re-acceptance on change (snapshot-per-booking is enough now).
- Strata self-service portal (deferred product-wide).
- Per-sub-client terms.
- ID intake consent.

## Rollout

Migration ships on the normal develop→main batch. Because the gate is data-driven
(empty terms ⇒ skip), it is inert until a client's `terms_markdown` is filled in — so it
can ship ahead of go-live and be switched on per council by writing their terms.

**PR split (Eng review F5 — mandatory, or Types-Freshness CI redballs):**
- **PR-A** — migration only: column adds (`client.terms_markdown`, `booking.terms_accepted_at`,
  `booking.terms_accepted_text`, + acceptor/version cols per the approved gate decisions),
  the `client_has_terms()` helper, the `booking_resident_insert` RLS `WITH CHECK` term, and
  the full `CREATE OR REPLACE create_booking_with_capacity_check` with `p_terms_accepted`
  (DEFAULT false, after `p_type`; both callers use named args so existing calls keep
  compiling). Release to main → prod → regen `types.ts`.
- **PR-B** — consumers: EF + `createMudBooking` pass the flag; confirm-form + mud-form
  dialogs; admin Terms tab; regen'd types; all tests.

---

## Autoplan review — resolutions (2026-06-23)

Reviewed via autoplan; `codex` unavailable, so dual-voice degraded to `[subagent-only]`
(independent Claude CEO/Design/Eng reviewers). Consensus is single-voice.

### Consensus tables (single-voice)

```
CEO     1 premises valid? NO  2 right problem? YES  3 scope calib? UNSURE
        4 alternatives explored? NO  5 compliance covered? NO  6 6-mo sound? UNSURE
DESIGN  1 hierarchy sound? UNSURE  2 all states specified? NO  3 a11y? NO
        4 admin editor complete? NO  5 mobile considered? NO
ENG     1 arch sound? YES(w/ fixes)  2 RPC true chokepoint? NO(F2)  3 sig change safe? YES(needs split)
        4 edge cases? PARTIAL  5 no client-forged acceptance? NO→YES once F2 closed  6 tests? NO
```

### Auto-decided (6 principles) — folded into the spec above + the design deltas below

| # | Finding | Decision | Principle |
|---|---|---|---|
| 1 | Eng F2 — RLS direct-insert bypass | FIX: mirror WS-A `WITH CHECK` + `client_has_terms()` | P1 + Red Line #7 |
| 2 | Eng F5 — one-PR redballs CI | SPLIT PR-A/PR-B | mechanical |
| 3 | Eng F1 — spec said DEFINER | CORRECT to INVOKER + chokepoint caveat | mechanical |
| 4 | Eng F3 — EF early-403 lacks terms data | Rely on RPC RAISE as durable layer; map RAISE → clean 4xx (branch like `Insufficient`); EF early-403 optional polish only | P3 |
| 5 | Eng F4 — RPC body must be re-declared | New migration = full `CREATE OR REPLACE` + 2 cols + gate | mechanical |
| 6 | Eng F7 / Design F7 — "has terms" predicate drift | One `clientHasTerms` = `(md??'').trim().length>0`, shared via `_shared`↔`src/lib` mirror; identical SQL `client_has_terms`; store trimmed/NULL on save | P4 DRY |
| 7 | Eng F10 — test gaps | Add: omitted-flag-defaults-closed RAISEs; direct-insert-bypass denied (RLS); whitespace-only = no-terms; assert snapshot == trimmed stored text | P1 |
| 8 | Design F1 — modal fetch-race could silently skip consent | Modal is an explicit state machine: terms `undefined` on submit ⇒ block + resolve query (never skip); fetch error ⇒ block with retry copy (RPC is backstop) | P1 |
| 9 | Design F2 — no Dialog primitive | Build on `@base-ui/react/dialog` per `bug-report-dialog.tsx` (focus trap/Esc/aria); add `Dialog.Description` | P5 |
| 10 | Design F4 — gate vs OTP ordering / auth bypass | Intercept in `onSubmit` **before** the `if (session)` branch so authenticated AND guest paths pass the gate; gate fires before OTP | P1 (correctness) |
| 11 | Design F5 — mobile long-doc modal | Fixed layout: title header, markdown body in own `overflow-y-auto max-h`, checkbox+actions in pinned footer; near-fullscreen on mobile | P1 |
| 12 | Design F6 / CEO F3 — blank = consent-off footgun | Admin Terms tab + go-live checklist show "No terms configured — residents book with no consent step" when empty | P1 |
| 13 | CEO F4 — pre-terms bookings edited after terms switched on | GRANDFATHER: pre-terms bookings keep NULL acceptance; in-place edit does not retro-require terms. Documented. | P5 explicit |
| 14 | CEO F9 — compliance absent | Add Compliance section (below); content is the council's responsibility | P1 |

### Design deltas (applied)

- **Resident dialog** is gated in `onSubmit` before the `if (session)` branch (Design F4),
  is a state machine (Design F1), built on `@base-ui/react/dialog` (Design F2), with a
  pinned-footer mobile layout (Design F5). Single checkbox, no scroll-gate (see Open
  decision D3). Checkbox uses `<label htmlFor>`; modal is `aria-describedby` the terms.
- **Admin Terms tab** shows an explicit empty-state warning (Design F6); keeps
  `saving/error/saved`; trims on save; treats whitespace-only as empty.
- **Shared predicate** `clientHasTerms` across UX/EF/RPC/RLS (Eng F7).

### Compliance (CEO F9)

- The **content** of the terms is the council's responsibility, not D&M's. The admin
  Terms tab carries a note to that effect ("Terms entered here are the council's; Verco
  captures acceptance only").
- Retained record = text snapshot + (per approved decisions) version + acceptor + channel
  + timestamp — the APP-defensible minimum.
- ACTION (Dan): confirm with at least one council whether their procurement contract
  dictates a specific consent-capture/evidence method before go-live. 30-minute check
  that could save a schema change.

### Approved decisions (gate, 2026-06-23 — all recommendations accepted)

- **D1 (legal): APPROVED** — record `terms_accepted_by` + `terms_accepted_channel`
  (`resident_self | staff_on_behalf | mud_admin`). Staff-on-behalf is recorded as an
  acknowledgement, distinguishable from resident self-consent.
- **D2 (data model): APPROVED** — add `client.terms_version` + snapshot
  `booking.terms_version`.
- **D3 (UX): APPROVED** — single "I have read and accept" checkbox, enabled immediately,
  gates the Accept button. No scroll-gate.
- **D4 (content source): APPROVED** — host the council's terms as markdown in Verco
  (snapshot-able, FAQ pattern). No council-URL link.

Deferred (Dan already ruled per-client, not per-sub-client): a nullable
`sub_client.terms_markdown` override (`COALESCE(sub_client, client)`) is noted as a cheap
future hedge if WMRC sub-clients ever need distinct terms — not built now.
