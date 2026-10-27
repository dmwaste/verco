# 0042 — A soft-deleted booking still uses its allocation

- **Date:** 27/10/2026
- **Status:** Accepted

## Decision

When a booking is soft-deleted (`deleted_at` set), it drops out of invoices, reports and the bookings list. It **still counts against the property's free allocation for the year**. Soft-deleting means "don't bill or report this record", not "this collection didn't happen".

If a soft-deleted booking was genuinely never collected, staff give the resident their collection back with an **allocation override**, the existing per-property top-up. The usage count itself isn't changed.

## Why

D&M soft-deletes bookings mainly to stop them being billed twice, not because the work didn't happen. On 08/09/2026, 91 Verge Valet bookings were soft-deleted: 45 Cambridge, 45 Vincent and 1 Cottesloe. All were August collections the crews had completed. WMRC had already been invoiced for them through the old Airtable records (INV-2295 and INV-2296). Keeping Verco's copies on the invoice would have billed about $9,084 a second time.

Those residents still had their August collection. If soft-deleted bookings stopped counting, 35 of them who have used their full allowance would get another free collection. WMRC would then be billed for collections beyond their entitlement. On 27/10/2026, this was the outcome of changing the rule.

Cancelled bookings are different and still don't count. Neither do bookings awaiting payment, or a booking replaced by a rebook. Those cover the cases where the collection didn't happen.

Kwinana MUD bookings are unaffected either way. Staff book MUDs on their own page, which doesn't check the allocation.

## What this changed from the original plan

Nothing in the code. The allocation count already ignored `deleted_at`; it was never written down. On 27/10/2026 it was first read as a bug, because every billing and report path does exclude soft-deleted bookings. Checking the live data showed the count was right. This entry records that, and a note on the database function says the same, so nobody "fixes" it later.
