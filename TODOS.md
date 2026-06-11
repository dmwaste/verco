# TODOS

## Surface FAQs on the public booking flow

- **What:** Render the FAQ accordion (markdown-formatted answers) somewhere in the `/book` flow, not just `/contact`.
- **Why:** The admin FAQ editor claimed FAQs display "on the public booking page" since it shipped (fixed in the FAQ markdown PR — they render on `/contact` only), suggesting booking-page surfacing was the original intent. Residents mid-booking are the audience with the most questions (accepted items, volume limits, cutoffs) and are currently three clicks from the answers.
- **Pros:** Answers reach residents at the decision moment; likely reduces non-conformance notices and support calls; `FaqAnswer` + `FaqAccordion` are drop-in reusable after the FAQ markdown PR (accordion accepts `ReactNode` answers).
- **Cons:** `/book` is a focused conversion funnel — added content risks distraction; needs a deliberate UX decision on placement (sidebar, services step, or confirm page).
- **Context:** As of 2026-06-11, `FaqAccordion` renders only on `(public)/contact/page.tsx`. The FAQ markdown PR (formatted answers, RSC rendering, a11y fixes) makes the components reusable anywhere. Content per tenant lives in `client.faq_items`, editable via the admin FAQs tab.
- **Depends on / blocked by:** FAQ markdown PR landing first.
