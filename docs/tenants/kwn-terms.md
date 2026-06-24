# City of Kwinana (`kwn`) — Booking Terms & Conditions

Versioned mirror of the `kwn` client's `client.terms_markdown` value. The database is canonical; keep this file in sync whenever the terms change.

- **Apply via:** Admin → Clients → City of Kwinana → **Terms** tab — paste the block below, then Save.
- **Renderer:** `src/components/faq-answer.tsx`. External `https://` links auto-open in a new tab (`target="_blank" rel="noopener noreferrer"`); there is no `rehype-raw`, so keep the content markdown-only (raw HTML renders inert).
- **Gate behaviour:** the acceptance modal is dormant while `terms_markdown` is NULL/blank. Saving this content switches the consent step on for Kwinana bookings.
- **Linked terms source:** <https://www.kwinana.wa.gov.au/property-and-pets/waste-and-recycling/pre-booked-verge-collections/pre-booked-verge-collections-terms-and-conditions> · last reviewed 23/06/2026.

## Content

```markdown
Please read the following conditions, then check the box below to confirm your acknowledgement.

- I will not exceed the allocation limits for each collection type booked.
- I understand that the collection team cannot collect waste from within my property boundary.
- I understand that collections occur between 7am and 4pm on my collection date. I will be notified if collection is to occur outside of these hours.
- I understand that the waste will be mechanically collected, and I will position it so as to avoid damage to services and infrastructure.
- I have read and understood the attached [Terms & Conditions](https://www.kwinana.wa.gov.au/property-and-pets/waste-and-recycling/pre-booked-verge-collections/pre-booked-verge-collections-terms-and-conditions).
```
