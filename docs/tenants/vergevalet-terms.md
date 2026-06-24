# Verge Valet (`vergevalet`) — Booking Terms & Conditions

Versioned mirror of the `vergevalet` client's `client.terms_markdown` value. The database is canonical; keep this file in sync whenever the terms change.

- **Apply via:** Admin → Clients → Verge Valet → **Terms** tab — paste the block below, then Save.
- **Scope:** `terms_markdown` is per-client, and Verge Valet fans out to multiple sub-clients (e.g. City of Cockburn) under WMRC. This one block therefore covers **every** Verge Valet sub-client — keep the wording generic, not council-specific.
- **No external T&Cs:** Verge Valet has no separate council terms page, so there is no hyperlink — these acknowledgements *are* the terms. (Contrast `kwn`, which links out to the council's page.)
- **Renderer:** `src/components/faq-answer.tsx`; there is no `rehype-raw`, so keep the content markdown-only (raw HTML renders inert).
- **Gate behaviour:** the acceptance modal is dormant while `terms_markdown` is NULL/blank. Saving this content switches the consent step on for Verge Valet bookings.
- Last reviewed 23/06/2026.

## Content

```markdown
Please read the following conditions, then check the box below to confirm your acknowledgement.

- I will place items out for collection no more than three days before my collection date.
- I will not exceed 3m³ (3m x 1m x 1m) per allocation booked.
- I understand that the Verge Valet Collection Team can only collect waste from the location I have indicated on my verge unless I have agreed an alternative with the Team.
- I understand that collections occur between 7am and 4pm on my collection date. I will be notified if the collection is to occur outside these hours.
- I understand that the waste will be mechanically collected, and I will position it to avoid damage to services and infrastructure.
- I understand that if I change or cancel my booking after 3:30pm on the business day before my collection, I will lose my collection allocation.
```
