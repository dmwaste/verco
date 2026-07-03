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

## Admin design-debt batch (deferred from 2026-07-03 dashboard design review)

- **What:** Systemic admin-surface cleanups the dashboard review surfaced but deliberately kept out of that PR: (1) one `<StatusBadge entity status>` component wrapping `getStatusStyle` — `BookingStatusBadge` duplicates `status-styles.ts` verbatim and the pill markup is re-typed with drift in 4 files; (2) admin-wide `focus-visible` convention — zero hits in the `(admin)` tree, and 4 list-page search inputs use `outline-none` with no replacement; (3) semantic colour tokens — 35 distinct hexes, success appears as 6 different greens, warning as 7 oranges; (4) `--text-caption: 11px` token (11px is the most-used small size, ×216, with no token); (5) extract `PageHeader`/`FilterBar`/`Th`/`Pagination` (3 divergent pagination variants); (6) `tabular-nums` on table numeric/date columns; (7) fix bookings empty-row `colSpan={9}` on an 8-column table (`bookings-list-client.tsx:376`); (8) reconcile "Under Review" amber (NCN) vs blue (NP) in `status-styles.ts`.
- **Why:** Each is invisible individually but together they are why success renders as six greens and keyboard focus disappears; copy-paste drift already produced the colSpan defect.
- **Cons:** Wide mechanical diff across ~28 admin files; deserves its own PR + review, not a rider.
- **Context:** Full findings in `~/.gstack/projects/dmwaste-verco/designs/design-audit-20260703/design-audit-admin-dashboard.md` (deferred section). Dashboard-page instances were fixed on the design-review branch (F-001…F-012).
- **Effort:** M (human, ~2 days) → S with CC. **Priority:** P3 (P2 for the colSpan bug + focus-visible, which are user-visible).

## Extract a shared brand-colour normalization helper

- **What:** Replace the duplicated `colour.startsWith('#') ? colour : '#'+colour` coercion with a single `normalizeBrandColour()` util (e.g. in `lib/branding/`).
- **Why:** The same coercion lives in at least `src/app/(field)/field/layout.tsx:78` and `src/app/(public)/layout.tsx:90`; a third copy would be easy to add inconsistently.
- **Pros:** One place to change brand-colour handling; matches the DRY preference; trivial to test.
- **Cons:** Pre-existing and tangential — not worth bundling into an unrelated PR.
- **Context:** Surfaced during the 2026-06-17 per-tenant favicon eng review (deliberately kept out of the favicon PRs to keep that diff surgical). Both call sites build the same `--brand*` CSS-var object.
- **Effort:** S (human) → XS with CC. **Priority:** P3.

