# TODOS

## Surface FAQs on the public booking flow

- **What:** Render the FAQ accordion (markdown-formatted answers) somewhere in the `/book` flow, not just `/contact`.
- **Why:** The admin FAQ editor claimed FAQs display "on the public booking page" since it shipped (fixed in the FAQ markdown PR — they render on `/contact` only), suggesting booking-page surfacing was the original intent. Residents mid-booking are the audience with the most questions (accepted items, volume limits, cutoffs) and are currently three clicks from the answers.
- **Pros:** Answers reach residents at the decision moment; likely reduces non-conformance notices and support calls; `FaqAnswer` + `FaqAccordion` are drop-in reusable after the FAQ markdown PR (accordion accepts `ReactNode` answers).
- **Cons:** `/book` is a focused conversion funnel — added content risks distraction; needs a deliberate UX decision on placement (sidebar, services step, or confirm page).
- **Context:** As of 2026-06-11, `FaqAccordion` renders only on `(public)/contact/page.tsx`. The FAQ markdown PR (formatted answers, RSC rendering, a11y fixes) makes the components reusable anywhere. Content per tenant lives in `client.faq_items`, editable via the admin FAQs tab.
- **Depends on / blocked by:** FAQ markdown PR landing first.

## Council contact form on verco.au landing (deferred from landing redesign)

- **What:** Replace the landing page's mailto-CTA with a real contact form (server action + EF email + spam protection).
- **Why:** mailto silently no-ops on locked-down council SOE machines; a form also enables tracking.
- **Pros:** Reliable capture of partner enquiries; measurable funnel.
- **Cons:** New EF + notification plumbing + spam defence for a low-volume surface.
- **Context:** Landing redesign (2026-06-11 autoplan) shipped mailto + visible selectable email text as the v1 mitigation. Trigger: partner enquiries outgrow mailto.
- **Effort:** M (human) → S with CC. **Priority:** P3.

## Live operations stats band on landing (deferred)

- **What:** "X collections booked" aggregate on verco.au.
- **Why:** Strongest social proof for council evaluators.
- **Cons/Blocker:** Needs Dan's call on WHICH number to publish (not a policy violation — public aggregate ≠ cross-client report; re-tagged in CEO review F9).
- **Effort:** M → S with CC. **Priority:** P3. **Depends on:** Dan picking the number.

## Capability one-pager PDF for council tenders (deferred from landing redesign — named critical-path item)

- **What:** Downloadable capability statement (collections delivered, booking volumes, NCN evidence trail, CPPPH) linked from the landing for-councils section; content reuses the page's value props.
- **Why:** The artefact that actually circulates among LGA tender evaluators and scores points — higher leverage than further landing polish (CEO voice F8).
- **Context:** Suggested owner: /cmo agent. **Deadline anchor:** tender calendar, not "someday".
- **Effort:** M (content) — design reuses landing assets. **Priority:** P2.

## Landing analytics decision (deferred with deadline)

- **What:** Decide how to measure the landing page (Coolify access-log grep floor vs lightweight analytics).
- **Why:** Page effectiveness is currently structurally unmeasurable; mailto conversions are untrackable.
- **Context:** CEO review F6 (2026-06-11). **Deadline:** next tender cycle or first council-sourced enquiry, whichever first. Floor: quarterly access-log grep for /landing referrers.
- **Effort:** S. **Priority:** P3.

## Tenant host rename: kwntest/vvtest → canonical booking hostnames

- **What:** Migrate client.custom_domain values (and DNS + Coolify + auth-cookie implications) off test-named hosts.
- **Why:** Residents book at, and SMS links resolve to, hostnames that literally say "test"; landing page cards now expose these in the URL bar (accepted at premise gate D3 with this TODO as the fix).
- **Cons:** DNS + Coolify + Supabase data + host-only OTP cookies + council comms on changed URLs — a real migration, not a rename.
- **Effort:** L (human, multi-day incl. comms) → M with CC. **Priority:** P2. **Depends on:** council comms window.

## Extract a shared brand-colour normalization helper

- **What:** Replace the duplicated `colour.startsWith('#') ? colour : '#'+colour` coercion with a single `normalizeBrandColour()` util (e.g. in `lib/branding/`).
- **Why:** The same coercion lives in at least `src/app/(field)/field/layout.tsx:78` and `src/app/(public)/layout.tsx:90`; a third copy would be easy to add inconsistently.
- **Pros:** One place to change brand-colour handling; matches the DRY preference; trivial to test.
- **Cons:** Pre-existing and tangential — not worth bundling into an unrelated PR.
- **Context:** Surfaced during the 2026-06-17 per-tenant favicon eng review (deliberately kept out of the favicon PRs to keep that diff surgical). Both call sites build the same `--brand*` CSS-var object.
- **Effort:** S (human) → XS with CC. **Priority:** P3.

## Survey system — deferred follow-ups (shipped 04/07/2026: #284/#285/#287/#288)

- **What:** Open threads after the resident survey system shipped + was prod-verified end-to-end.
- **Delete the `PEP-10636` test survey row** (`token = 'verco-review-form-20260704'`, a synthetic 5★ response left in prod for the admin-module review) **before real collections generate real surveys** — it skews the aggregate metrics. `DELETE FROM booking_survey WHERE token = 'verco-review-form-20260704'`.
- **Per-tenant configurable questions (deferred, decision D2):** the survey renders a fixed shared `SURVEY_QUESTIONS` set (`src/lib/survey/questions.ts`) — stable, cross-council-comparable analytics keys. The `client_survey_config` table exists but is unwired. Wire it (admin question editor + config-driven form + config-driven aggregation, keyed on question id) when a council needs custom questions beyond the core set. The `id`s ARE the analytics keys — never rename an existing one (orphans history).
- **Optional hardening:** survey reminder email for non-responders (new cron); token rate-limiting / attempt logging (low priority — the 128-bit token is unguessable).
- **Context:** Full detail in memory `survey-public-access-pipeline.md`; specs reconciled in PRD §11 / TECH_SPEC §13 (v1.1, #290).
- **Priority:** P1 (test-row delete, before first collections), P3 (config editor + hardening).

## Admin run sheets — deferred follow-ups (shipped 04/07/2026: PR #296)

- **Aggregate run-summary RPC (scale escalation):** the `/admin/run-sheets` list fetches every stop for a date via `fetchDayStops` (`fetchAllRows`, correct now) then groups in-memory. If a single date routinely exceeds ~1-2k stops, replace with a SECURITY DEFINER RPC that groups stops → run summaries in Postgres. **Must carry the §21 NULL-safe staff role gate** (`tenant-gate-is-not-an-authz-gate`) — `accessible_client_ids()` alone is not an authz gate. **Trigger:** observed per-date stop volumes in prod. **Priority:** P3.
- **Contractor-roles-only resident contact on the run-sheet detail:** v1 is address-only (`collection_stop` is PII-free by construction). Office staff often pull a run sheet to phone a resident about a missed/disputed collection. Add an optional contractor-roles-only join (a separate query, NOT the PII-free stop record) surfacing name + phone on the detail. **Needs:** RLS scoping + PII tests. **Trigger:** office confirms callbacks are a real workflow. **Priority:** P3.
- **Context:** Read-only, printable, contractor-only run sheets shipped via PR #296. Full state in memory `admin-run-sheets-feature.md`. Live visual QA (OTP login in preview) outstanding before the develop→main deploy.

## Exceptions (NCN/NP) — deferred follow-up (from eng-review 2026-07-06)

- **Unify the two exception table clients:** `non-conformance-client.tsx` and `nothing-presented-client.tsx` are near-duplicate copies of the same table screen. The NCN/NP investigations plan (`docs/superpowers/specs/2026-07-06-ncn-np-investigations-model-design.md`) deliberately kept them separate (decision 2C-A: DRY only the *new* code — one `openInvestigation` action, one `ExceptionCard`) to avoid refactoring working screens mid-feature. **What:** extract a shared `ExceptionsTable` parameterised by `kind: 'ncn'|'np'`. **Why:** every future exceptions tweak is currently a two-file edit that will drift. **Pros:** one place to change; **Cons:** refactors currently-working screens (regression surface). **Trigger:** next time both files need the same edit. **Priority:** P3.
- **Notice-tables-authoritative model (Codex #18, deferred):** longer-term, make notice records the single source and *derive* `booking.status` from them, collapsing the two state machines. Large rewrite touching `rollup_booking_status_from_stops`. **Trigger:** if booking.status↔notice drift causes recurring bugs. **Priority:** P3.
- **Sibling-pass status line on NCN/NP emails (from autoplan 2026-07-08, service-type-notices review):** add a dynamic line like "Your Green Waste collection is still scheduled for today" derived from sibling `collection_stop` rows on the same booking. **Why:** the KWN council-authored NCN paragraph ("keep your waste on the verge until both collections are complete") is static copy compensating for exactly this missing behaviour — the real driver of resident confusion/support calls on multi-pass bookings; naming the service (shipped by the parent spec) only helps at the margin. **Pros:** directly attacks council call volume; data already in DB at closeout time. **Cons:** new optional payload field on the notification envelope (back-compat additive), per-tenant copy consideration, sibling-status derivation at send time can race the other pass's closeout (state as "scheduled as of notice time"). **Context:** parent spec = service-type row on NCN/NP notices (plan file `~/.gstack/projects/dmwaste-verco/claude-distracted-lichterman-c8e718-plan-service-type-notices.md`); derive siblings at the closeout call site alongside the service label. **Depends on:** service-type row shipped. **Effort:** M human / S with CC. **Priority:** P2.
- **Resized photo renditions in NCN/NP notice emails (from /review 2026-07-08, PR #343):** inline `<img src>` points at the full-resolution storage URL — crew phone photos run 2–8MB each, so a 4-photo notice can trigger 10–30MB of downloads on the resident's phone. **What:** serve a ~1072px-wide rendition inline (retina 2× of the 536px slot) while the wrapping `<a href>` stays full-res. **How:** Supabase image transformations (`/storage/v1/render/image/public/...?width=1072&quality=75`) if the plan includes them — check first, a 400 breaks photos — else resize/compress at closeout upload and store both URLs. **Note:** `sanitizePhotoUrls` (dispatch trust boundary) currently allows `/storage/v1/object/public/` only; add `/storage/v1/render/image/public/` when switching. **Pros:** 10× lighter emails on mobile data; **Cons:** plan-feature dependency or upload-pipeline change. **Priority:** P2.
- **Crew-level fault tagging on ancillary NCNs (from autoplan 2026-07-08):** an ancillary-stop NCN currently (and after the service-type change) names every service in the pass, including compliant ones — e.g. a compliant e-waste pile is "blamed" alongside a non-conforming mattress. **What:** let the crew tag the offending service(s) at closeout (the stop closeout UI already lists `services_summary` items) and thread only those into the notice + email. **Why:** dispute accuracy; avoids false precision. **Pros:** durable design for service-level fault; **Cons:** field UX addition + notice schema column; only matters for multi-service ancillary NCNs. **Trigger:** first resident dispute arguing "my X was fine, it was the Y". **Priority:** P3.

