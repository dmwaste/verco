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
