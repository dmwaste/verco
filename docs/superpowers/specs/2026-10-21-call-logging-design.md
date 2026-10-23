# Call logging — design (VER-317)

**Status:** Draft for Dan's approval · **Date:** 21/10/2026 · **Decided with:** Dan Taylor (grill session, 21/10/2026)
**Linear:** [VER-317](https://linear.app/verco/issue/VER-317) · **Builds on:** caller lookup (VER-316), contact view log (VER-322, ADR 0040), closeout corrections (ADR 0030), our-fault exceptions (ADR 0039), invoice-counting rules (ADR 0017/0038)

## 1. Intent

D&M answers every resident call in Teams, and the Teams pop now opens the caller in Verco's caller lookup (`/admin/lookup`). Nothing records the call. HubSpot call logging stopped on 17/06/2026 and D&M is running no third-party CRM (decision 18/10/2026), so today a call leaves no trace. All 183 service tickets on prod are portal tickets.

This feature records **every call on a ticket**, so that:

- the office has a history of what each resident rang about and what was done;
- a resident who rings to say "you missed my collection" starts the WMRC rectification clock, and the redo is booked from the call;
- the WMRC contract measure, **≥ 90% of missed services rectified (rebooked) within 2 WA working days**, includes the misses residents report, not just the ones crews raise.

## 2. Goals, non-goals, anti-goals

**Goals**
- D&M staff log any call (incoming or outgoing) in a couple of taps from the caller lookup or a ticket page.
- A reported miss is confirmed or rejected, and the redo is booked, from the ticket.
- One honest 2-working-day figure covering crew notices and phone reports.
- Councils can see the calls logged about their residents, read-only.

**Non-goals (this release)**
- Council staff logging calls. Call logging is a D&M-only feature (Dan, 21/10/2026).
- Calling someone with no ticket (a proactive "we're running late" call).
- Email-to-ticket, SMS replies (VER-319), the resident timeline (VER-318).
- Call recording, telephony integration beyond the existing Teams pop.

**Anti-goals (would be a failure even if it works)**
- Billing a council twice for one collection, or billing a run that was missed.
- A 2-working-day figure that flatters D&M: counting rejected reports as successes, or hiding reports from councils.
- Resident contacts created with placeholder emails (the ADR 0027 trap: 278 residents once shared the WMRC office address).
- A call entry that emails the resident (staff ticket replies do today, via `notify-ticket-response`).
- Any resident contact detail reaching crews, rangers, Sentry or an export.

## 3. What was decided

### 3.1 Who

- **D&M staff only** (`contractor-admin`, `contractor-staff`) can log calls, confirm a miss, or book its redo. Enforced in the database (RLS / RPC role gates), not only by hiding buttons. Today `service_ticket_staff_insert` admits any client-tier staffer and, through `is_contractor_user()`, the `field` role. Phone tickets and call entries must be D&M-only at the database level.
- **Council staff** (`client-admin`, `client-staff`) **see** phone tickets and their call entries about their own residents, read-only, in the existing service-tickets screens, under the existing council and sub-client scoping.
- **D&M-only call notes** _(builder check: my call)_: a call entry ticked "internal" is hidden from council staff. This is a **new, D&M-only flag on call entries**. The existing `ticket_response.is_internal` only hides notes from residents, and it stays as it is: portal tickets don't change. Internal call notes must not reach councils through the History panel either (`audit_log`, ADR 0036/0037), so store them where council staff can't read them, and map that table D&M-only.
- **Council tag** _(my call)_: a phone ticket with no booking still has to reach the right council. For Verge Valet, Kim picks the council at **sub-client** level (Cottesloe, Fremantle…), not just "WMRC". Otherwise council officers narrowed to one council (ADR 0024) never see it.
- Field, ranger, resident and strata never see call entries.

### 3.2 Logging a call

**From the caller lookup** (the Teams pop), per contact card:

- each of the caller's **open tickets** shows **Log this call here**, which adds a call entry to that ticket;
- **Log a new call** opens the short form: outcome (3.3), note, optional booking link. For a missed-service report, the missed run(s) are picked too (3.4).

**From a ticket page** (D&M staff): **Log a call**, with a direction (incoming or outgoing) and a note. This covers call-backs: outgoing calls land on the ticket they're about.

**Unknown callers** (lookup miss): the call is logged against **the caller's number**, with an optional name Kim types and a council she picks (default: the switcher's). **No contact is created.** For phone tickets only, `service_ticket.contact_id` becomes optional, and the ticket stores the caller's number and name. If Kim books them in during the call, the booking wizard creates the contact properly, and a call logged afterwards finds and links to it. Never a placeholder email.

**From a booking page** _(my call)_: **Log a call** on the booking detail page (D&M staff). This handles a caller whose number isn't on file, such as a partner's phone or a different landline. They can still report a miss on that booking. The ticket attaches to the booking and its contact, and the call entry records the number that actually rang. Without this, those misses never reach the figure.

**Repeat calls** about the same issue go into the existing ticket via **Log this call here**. They add a call entry, don't start a new clock, and don't count as a new miss or complaint. The ticket shows how many calls it took. _(My call:)_ the lookup also lists **open tickets stored under the caller's number** when no contact matches, so an unknown caller's second call finds their first. Number-only tickets are **not** linked automatically to a contact created later, because a number is not a person (ADR 0027). Staff can link one by hand.

**A call entry** records: ticket, direction, who logged it, when, the number that rang (incoming), the note, and the D&M-only internal flag. It never notifies the resident.

**First response** _(my call)_: an incoming call is the ticket's first response, since a person answered. So is an outgoing call-back that isn't ticked internal, because the resident was spoken to. An internal call entry never is. This follows the existing rule (`stamp_first_response` stamps on a non-internal staff response).

### 3.3 Outcomes and what the ticket looks like after

The five outcomes: **enquiry answered, booking made or changed, missed-service report, complaint, other.** Kim's walk-through of about 10 recent calls happens in the first week of use, and the list may change after it, so keep it in one place and cheap to extend. The ticket's subject is generated from the outcome; Kim doesn't type one.

| Outcome | Ticket after logging | Note | Links |
|---|---|---|---|
| Enquiry answered | Resolved on the spot | Optional | Contact or number |
| Booking made or changed | Resolved on the spot | Optional | That booking |
| Missed-service report | Open, assigned to the logger, until confirmed or rejected (3.4) | **Required** | Booking + the missed run(s) |
| Complaint | Open, unassigned, high priority | **Required** | Booking if relevant |
| Other | Resolved on the spot, unless "needs follow-up" is ticked (then open) | Optional | Optional |

For an incoming call, first response is the call itself, since a person answered.

### 3.4 Missed-service reports

**Per run, not per booking.** A booking's crew runs are its `collection_stop` rows (one per waste stream). 1,266 of 8,087 bookings with stops have two or more live runs, so "you took the bulk but left the green" is common. Kim picks which run(s) were missed; if only one run is still open, it's pre-picked. This matches how Non-conformance, Nothing Presented and "D&M's fault" (ADR 0039) already work.

**Confirming or rejecting** (from the ticket):

| The run's stop is… | Who can confirm the miss | Notes |
|---|---|---|
| Pending, collection date passed | Any D&M staff | The crew never closed it |
| Pending, collection day is today | Nobody yet | The call can be logged now; confirming unlocks the next day |
| Completed, Non-conformance or Nothing Presented | `contractor-admin` only, ≤ 7 days after the stop's date, reason required | Overrules the crew: same rules and same correction log as ADR 0030's `correct_stop_outcome` |

**Rejecting** a report (for example "photo shows nothing presented"): D&M admin, reason required. The ticket closes with the reason, visible to the council.

**Per run, all the way through** _(my call)_: each reported run is confirmed or rejected on its own. For example, bulk was confirmed missed, but the photo shows green had nothing presented. All the confirmed runs of one report share **one redo booking**. The ticket closes once every reported run is decided. The figure (3.5) counts **runs**, as it already does for notices.

**Reports nobody can confirm under the rules** _(my call; none is left pending forever, which would flatter D&M)_:

| Case | Handling |
|---|---|
| Crew-closed run, more than 7 days after its date (outside ADR 0030's window) | Can't be overruled. Rejected with the reason "reported after the 7-day correction window", visible to the council. A **Pending** run has no 7-day limit, since the crew never closed it |
| The run already has a Non-conformance / Nothing Presented notice that's Disputed or Under Review | It's already a notice dispute. The ticket links to the notice and closes as "handled as notice dispute". The notice's own rectification counts in the figure, not the call (no double count) |
| The booking is already Rebooked because of a notice on a sibling run | The sibling run is still its own stop. The correction for the reported run must work on that stop. Fix the guard that refuses Rebooked bookings so it doesn't block a different run |
| The booking has no stops (push never ran) | Treat the booking as a single run |

**When a miss is confirmed**, in one action:
1. The missed run's stop gets a new terminal outcome, **Missed**. The booking shows the existing (never-used) **Missed Collection** status only when all its live runs were missed. Otherwise its status follows the other runs as today (rollup).
2. A **redo booking** is created for the missed run's items only: $0, landing Confirmed, linked to the ticket. Same pattern as the notice Rebook (`rebookNcn` / `rebookNp`).
3. The resident gets the new apology message (3.7).

**The redo's date** is the area's **next available scheduled collection day**: the first normal collection day with room for the run's items. Days already locked for routing are allowed, as with the notice Rebook (ADR 0026). Kim can pick a later scheduled day if the resident asks. **No out-of-schedule dates.** Most areas collect once a week, and the rectification clock (3.5) stops at booking, not completion, so the normal schedule is enough.

**Billing:** a Missed run's units are **not billed**; the redo's units bill as normal. The council pays once for each collection. This must hold in both the invoice report (`get_client_monthly_report`) and the Bookings-screen totals (`get_booking_tally`), which a test already pins together (ADR 0038). The tally already labels Missed Collection "billed once, on the redo".

### 3.5 The 2-working-day measure (the SLA dashboard's rectification card)

- **One figure, three sources:** crew Non-conformance, crew Nothing Presented, and phone missed-service reports.
- **Definition change (Dan, 21/10/2026): "rectified" means the redo is booked within 2 WA working days**, not completed. This applies to **all three sources**. Today `get_rect_sla` stops the clock when the rebooked booking is Completed. That changes, and past months are recalculated on the new rule. The card states the date the definition changed. It's a dashboard figure, not an invoice, so nothing billed moves.
- **Phone reports:** the clock runs from the call (ticket created) to the redo being booked (miss confirmed). Reports still being checked are pending and counted nowhere. Rejected reports count in neither numerator nor denominator, and stay visible with their reason.
- Working days: WA Mon–Fri minus `public_holiday` (WA), AWST dates, as the existing `workingDaysBetween` and `get_rect_sla` do.
- **Other council-visible measures** _(my call, following the "doesn't flatter D&M" rule Dan agreed in Q6)_: a Missed run counts as a **failure** wherever a miss belongs:
  - **On-time** (`get_on_time_monthly`): a Missed run is not on time. Today it would silently drop out, because only Completed stops are counted.
  - **Clean Collection** (`clean-collection.ts`): a Missed run is a miss, like a D&M's-fault notice.

### 3.6 Service Ticket card and call volume

- The existing Service Ticket card (first response ≤ 3 working days, resolution ≤ 30 days) counts **only phone tickets that needed follow-up**: missed-service reports, complaints, and "other" with follow-up ticked. Calls resolved on the spot are excluded, so they can't flatter the figure.
- **New figure: calls logged per month, by outcome, incoming vs outgoing.** It counts call entries, not tickets.

### 3.7 Telling the resident

- **A new message, "we missed you"**, sent when a miss is confirmed and its redo booked: email, plus SMS where the contact has an SMS-capable mobile. It names the missed service, the address and the redo date, says there's no charge, and asks them to put it out. The usual day-before reminder still follows.
- Not sent for rejected reports; Kim handles those on the call or by ticket reply.
- **Wording is Dan's call:** draft it for his approval before go-live. It's a new code-defined template, not `booking_created`, which would read as a new booking.
- Unknown callers (no contact) get nothing automatic.

## 4. Constraints (from the codebase and CLAUDE.md)

- **RLS first:** new tables get RLS, explicit GRANTs in the same migration (`migration-grants.test.ts`), the audit trigger and council mapping (`audit-council-map.test.ts`), and RLS tests in `rls.test.ts`. Verify on prod in a self-rolling-back block before release (the RLS suite doesn't run in CI).
- **Schema changes ship before their consumers:** new enum values (stop `Missed`, ticket outcome) and columns go in a migration PR, are released, then the consumer PR follows with regenerated types (the Types Freshness gate).
- **The booking state machine trigger** (`enforce_booking_state_transition`) and stop immutability must admit the new transitions only through the sanctioned path. A crew-closed run is changed only via the ADR 0030 correction mechanism (contractor-admin, ≤ 7 days, logged).
- **OptimoRoute:** a Missed stop is not a crew closeout. It must not be reported to OR as `success` (`sync-completions-to-optimoroute`). The redo reaches OR through the hourly push like any booking. A redo booked after the 8pm route share for the next day needs a manual re-share (ADR 0028); show a warning.
- **Watchdogs:** a Missed stop is terminal, so it should drop out of the stale-closeout alert (#575).
- **Capacity:** the redo respects the date's capacity rules as the notice Rebook does (pooled areas read `collection_date_pool`).
- **Notifications:** go through the existing dispatcher with the send claim (ADR 0035); idempotent per channel.
- **PII:** no resident details in Sentry, logs, exports, fixtures or commit messages. Unknown callers' numbers are resident PII too.
- **Contact view log:** opening a ticket that shows a resident's details is a contact view surface (CLAUDE.md §4). The builder decides whether the ticket page should log views; at minimum the lookup already does.
- **ADRs to write:** the one-measure / "rebooked within 2 working days" definition; per-run misses and their billing; D&M-only call logging.

## 5. Left to the builder

- Table and column shapes: where call entries live (a new table, or `ticket_response` with a call kind, provided it never triggers the resident email), and how the missed run(s), redo booking, confirm/reject state and reasons are stored.
- How rollup handles a booking with some runs Missed and others Completed or excepted, provided billing follows 3.4 exactly.
- Screen layout and copy (other than the resident message, which Dan approves).
- How "resolved on the spot" is recorded so the Service Ticket card can exclude it.
- How the existing `rebookNcn` / `rebookNp` logic is shared or reused for the redo.

## 6. Open questions (Dan's)

The builder check (21/10/2026) left three that change what gets built:

1. **A miss confirmed after its month was invoiced.** Example: a 28/10 collection is confirmed missed on 03/11, after October's invoice. Does October's report change, or does the credit land in November?
2. **Misses reported in writing (portal tickets).** Can D&M turn a portal ticket into a missed-service report, so it gets runs, confirm/reject and a redo, and counts in the figure from when the ticket was raised?
3. **Residents seeing phone tickets.** A resident sees every ticket on their contact today, including its message, and can reply to it. Should phone tickets show to the resident?

## 7. Calls made in the builder check (for Dan to check)

- D&M-only internal flag on call entries; portal tickets unchanged (3.1).
- Council tag at sub-client level for Verge Valet phone tickets (3.1).
- **Log a call** on the booking page, for callers whose number isn't on file (3.2).
- Lookup lists open tickets under an unknown caller's number; no automatic linking (3.2).
- First response: an incoming call, or a non-internal call-back (3.2).
- Confirm/reject per run; one redo per report; the figure counts runs (3.4).
- Handling of unconfirmable reports (3.4 table).
- Missed runs count as failures in On-time and Clean Collection (3.5).
