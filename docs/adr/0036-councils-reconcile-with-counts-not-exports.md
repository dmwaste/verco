# 0036 — Councils reconcile invoices with on-screen counts, not exports, counted exactly as the invoice is

- **Date:** 21/10/2026
- **Status:** Accepted

## Decision

Council staff check D&M's monthly invoices on the Bookings screen itself. They filter, ticking as many statuses, areas, types and services as they like, and Verco totals every matching booking, not just the page on screen. Those totals are counted **exactly as the invoice is**: the same statuses count as billable, the same units, the same mattress rule. There is no export, and the totals carry no names, addresses or contact details.

## Why

WMRC asked (12/10/2026) for an Excel export of filtered bookings so it could verify each invoice. Dan declined on 13/10: an export is a copy of residents' personal details that leaves Verco's access control and goes stale the moment it is saved. WMRC accepted that (16/10) and asked instead for better filters and an automatic tally per category. That meets the real need, "does the invoice match what was done?", without any personal data leaving the platform.

The tally is only useful if it agrees with the invoice. If WMRC's on-screen number and D&M's invoice ever differ, the feature has created a dispute instead of settling one. So the tally does not have its own idea of "billable". It uses the invoice's rule (ADR 0017), and a test fails if the two ever drift apart. On September 2026 every council's Included units matched the invoice report to the unit, by service, before this shipped (Verge Valet 2,691, Kwinana 1,548).

Three things follow from counting the invoice's way:

- **Nothing Presented and Non-conformance sit inside the billable subtotal**, each as its own line. D&M attended the property, and both contracts pay for the attendance (ADR 0017). The screen never calls them "non-chargeable". How that is explained to a council is a conversation for Dan, not something the screen decides.
- **Scheduled bookings past their date show outside the billable total**, labelled "outcome not recorded". That gap is unfinished closeout work. It is not folded in to make the numbers look tidy.
- **Crew-logged mattresses (Verge Valet) are counted from the crew's closeout of each stop**, on that stop's date, as on the invoice, not from what the resident booked.

Two smaller decisions come with it:

- **Deleted bookings no longer appear in the Bookings list.** 91 de-duplicated Verge Valet bookings from August were still listed as Completed, although the invoice excludes them. A council counting the list would have been 91 over.
- **The totals hide while the search box is in use.** Search is for finding one booking. Hiding the totals there means the counting never has to match on residents' names or addresses.

The totals are available to every office user (D&M staff and council staff, for any council), each seeing only their own council. WMRC asked first, but Kwinana's staff have the same need, and their access rules are already enforced the same way.
