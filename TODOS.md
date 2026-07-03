# TODOS

## [P1 SECURITY] Admin client switcher lets a client-admin scope into another council

- **What:** `getCurrentAdminClient()` / `getAccessibleAdminClients()` (`src/lib/admin/current-client.ts`) validate the switcher cookie and build the switcher dropdown by querying the `client` table filtered only by `is_active = true`. `client` is a **public-SELECT** table (RLS `USING (is_active = true)`), so the re-query validates *any* active client id — it does NOT scope to the user's `accessible_client_ids()`, despite the docstring (lines 15-18) claiming it does.
- **Impact:** A client-tier admin (e.g. City of Kwinana `client-admin`) sees every active council in their switcher dropdown and can select one, OR set the `verco_admin_client` cookie to any enumerable client UUID. The admin dashboard then scopes its **public-SELECT** surfaces to the chosen council: upcoming collection dates + capacity utilisation, the week widgets, and — via `getTenantMudPropertyIds` → `v_mud_next_expected` — that council's **MUD addresses, unit counts, cadences, next-expected dates** (the VER-280 data class). Booking/ticket queries stay RLS-scoped (return empty), so the leak is confined to the public-SELECT surfaces, but that still includes resident-adjacent MUD address data.
- **Fix direction:** Validate the candidate id against `accessible_client_ids()` (or a `user_roles` join) instead of the public-SELECT `client` table, in BOTH `getCurrentAdminClient` (cookie/header validation + first-accessible default) and `getAccessibleAdminClients` (switcher list). Preserve contractor-admin/contractor-staff seeing all their contractor's clients. Add an RLS/scoping smoke test per role. Correct the now-false docstring.
- **Why not in the design-debt release:** Pre-existing (not a regression from #271-#273); touches an auth path and needs its own tested PR — surfaced by the 2026-07-03 pre-merge review of the release batch. Verified by reading the code, not just the advisory.
- **Effort:** S (human) → XS with CC, plus test. **Priority:** P1.

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

