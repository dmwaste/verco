# Ticket reply email notification (staff → resident) — design

**Date:** 2026-07-07
**Status:** Approved (design), ready for implementation plan
**Scope:** Service ticket module

---

## Goal

When a staff member posts a **public reply** on a service ticket, email the
resident (the ticket's contact) with:

1. The ticket details (reference, subject, category)
2. The staff reply text
3. A direct link to their ticket in the resident portal

Email channel only. Internal notes never notify. This is the first
notification of any kind in the service ticket module.

---

## Context — what exists today

- **Service tickets** (`service_ticket`) belong to a `client` (NOT NULL) and a
  `contact` (NOT NULL), and *optionally* to a `booking` (`booking_id` nullable).
  `display_id` is the human reference (e.g. `KWN-1234`).
- **Ticket replies** live in `ticket_response` with `author_type` (`'staff'` |
  `'resident'`), `is_internal` (staff-only notes), `message`, `channel`.
- **Resident replies** go through a dedicated EF `create-ticket-response`.
- **Staff replies** are a **direct client-side insert** from
  `admin-ticket-detail-client.tsx` (`handleSendReply`) via the browser anon
  client + RLS. There is no server action or EF for staff replies.
- **No notifications exist anywhere in the ticket module today** — not on
  ticket creation, resident reply, or staff reply.

### Why the existing notification system doesn't fit

The whole notification stack is **booking-shaped**:

- `NotificationType` union, the `send-notification` EF, and the `dispatch()`
  orchestrator all load a `BookingForDispatch` context and key idempotency on
  `booking_id`.
- A service ticket is a different entity — its `booking_id` is nullable.

Forcing tickets through `dispatch()` would mean making the union ticket-aware,
adding a ticket loader branch, and threading a nullable `booking_id`
everywhere — significant blast radius on a **money-path EF** (Stripe /
booking-critical) for a fundamentally different entity.

**However** `notification_log.booking_id` is **nullable at the DB level** (only
`client_id` is NOT NULL), so ticket sends can still be logged to the same table
for observability, with `booking_id = NULL` and `reference_id =
ticket_response.id` for idempotency.

`notification_log.notification_type` is a **free-text** column (no CHECK
constraint), and `reference_id` (uuid) already exists. **→ No DB migration and
no types regen are required.**

---

## Chosen approach — Option A: notify-only Edge Function

Considered and rejected:

- **Option B — full staff-reply EF** (move insert + status update + notify
  server-side, mirroring the resident EF). More robust and symmetric, but
  rewrites a working RLS-backed admin insert + optimistic UI — a larger, riskier
  diff to code that isn't broken.
- **Option C — DB trigger + pg_net** on `ticket_response` insert. Keeps the
  client untouched, but pg_net GUC handling is a known dead-end in this repo,
  async errors are opaque, and it fires on every insert path. Least testable.

**Option A** keeps the staff reply insert as-is and adds the notification as an
isolated, testable Edge Function. It mirrors the booking pattern of "mutation
commits, then fire-and-forget to a notification EF". Idempotency via
`reference_id` makes the fire-and-forget safe against double-invoke.

---

## Trigger flow

```
Staff clicks "Send Reply" (replyMode === 'reply')
  → insert ticket_response (author_type:'staff', is_internal:false)      [unchanged]
  → optimistic UI update + (if open) status → waiting_on_customer        [unchanged]
  → fire-and-forget POST /functions/v1/notify-ticket-response
        body: { ticket_response_id }                                     [NEW]
```

- Fires **only** when `replyMode === 'reply'` (public). Internal notes (`replyMode
  === 'internal'`) never trigger the fetch. The EF *also* guards on
  `is_internal` server-side — defence in depth.
- Uses the browser session access token
  (`supabase.auth.getSession()` → `Authorization: Bearer <token>`).
- Fire-and-forget: errors are `console.error`-logged and never block the UI or
  the (already committed) reply insert. Same contract as `invokeSendNotification`.

---

## New Edge Function: `supabase/functions/notify-ticket-response/index.ts`

Follows the existing EF pattern (auth → parse → validate → execute).

**Auth (dual):** accept a service-role bearer **or** a user JWT whose
`current_user_role()` is in `('contractor-admin','contractor-staff',
'client-admin','client-staff')`. Never `field` / `ranger` / `resident`.

**Input (zod):** `{ ticket_response_id: z.string().uuid() }`

**Execution (service-role client for reads/writes):**

1. Load `ticket_response` by id (`author_type, is_internal, message, ticket_id`).
   - **Guard:** if `author_type !== 'staff'` → return 200 `{ status: 'skipped',
     reason: 'not_staff' }`.
   - **Guard:** if `is_internal === true` → return 200 `{ status: 'skipped',
     reason: 'internal_note' }`.
   - Guards return **HTTP 200 no-op** (not an error) — a mis-fire must be
     harmless.
2. Load `service_ticket` by `ticket_id`
   (`display_id, subject, category, client_id, contact_id, booking_id`).
3. Load `contacts` by `contact_id` (`full_name, email`).
   - If no email → write a `failed` `notification_log` row, return 200
     `{ status: 'no_email' }`.
4. Load `client` branding by `client_id`
   (`name, logo_light_url, primary_colour, email_footer_html, slug,
   custom_domain, reply_to_email, email_from_name`).
5. **Idempotency:** if a `sent` `notification_log` row exists for
   `reference_id = ticket_response_id AND notification_type = 'ticket_response'
   AND channel = 'email'` → return 200 `{ status: 'skipped', reason:
   'already_sent' }`.
6. Render via `renderTicketResponse(...)` → `{ subject, html }`.
7. Send via `_shared/sendgrid.ts` `sendEmail`:
   - `to`: `{ email: contact.email, name: contact.full_name }`
   - `from`: `{ email: client.reply_to_email ?? DEFAULT_FROM_EMAIL,
     name: client.email_from_name ?? client.name }`
8. Write `notification_log`:
   - `booking_id = ticket.booking_id` (may be NULL)
   - `contact_id, client_id, channel: 'email',
     notification_type: 'ticket_response', reference_id: ticket_response_id,
     to_address: contact.email, status: sent|failed, error_message`
9. Return 200 `{ status: 'sent' | 'failed', ... }`.

**Cross-cutting:**

- Wrap the handler in `withSentry` (`_shared/sentry.ts`), env-gated on
  `SENTRY_DSN`.
- Emit exactly one structured `console.log` line (`event:
  'ticket_notification_dispatch'`, ticket id, status, duration_ms, no PII).
- Emit documented JSON fields on **every** return path (success / no-op /
  error) — defaults belong in the EF, not the caller.
- Deploy convention follows the existing ticket EFs; auth is validated
  in-function regardless.

---

## New template — mirrored pair

Two copies, kept in sync by `scripts/sync-mirrors.sh`. The `_shared/` copy is
the source of truth. **No manual registration needed** — the script's mirror
loop globs every `_shared/templates/*.ts`, so a new template file is picked up
automatically; run the script in write mode to generate the Node mirror, and
the `--check` pre-push hook / CI guard enforces they stay identical.

- `supabase/functions/_shared/templates/ticket-response.ts` (Deno — source of truth)
- `src/lib/notifications/templates/ticket-response.ts` (Node mirror — for Vitest, generated by `sync-mirrors.sh`)

**Signature (pure function, decoupled from `BookingForDispatch`):**

```ts
interface TicketResponseEmailData {
  client: ClientBranding & { slug: string; custom_domain: string | null }
  ticketDisplayId: string
  ticketSubject: string
  categoryLabel: string      // human label, e.g. "Billing"
  replyMessage: string       // raw staff reply text
  ticketUrl: string          // absolute tenant URL to /contact/tickets/{display_id}
}

function renderTicketResponse(data: TicketResponseEmailData): { subject: string; html: string }
```

- Built on `renderEmailLayout` (`_shared/templates/_layout.ts`) for tenant
  branding (logo, primary colour, footer).
- **Subject:** `New reply to your enquiry [{ticketDisplayId}]`
- **Body:** intro ("A member of the {client.name} team has replied to your
  enquiry."), a details block (Ref / Subject / Category), the reply message
  (HTML-escaped via `escapeHtml`, newlines → `<br>`), and a hint that they can
  reply from the portal via the button.
- **CTA:** "View & reply" → `ticketUrl`, built in the EF via
  `buildBookingPortalUrl(client, '/contact/tickets/' +
  encodeURIComponent(displayId), appUrl)` (resolves to the tenant host —
  `custom_domain` → `{slug}.verco.au` → `appUrl` fallback).

The category → label map currently lives in `admin-ticket-detail-client.tsx`
(`CATEGORY_LABELS`). The EF needs the same mapping; duplicate the small const
into the EF (Deno can't import the client component) rather than over-abstract.

---

## Client helper

`src/lib/notifications/invoke-ticket-response.ts` — a small browser-side helper
(`'use client'`-safe) that POSTs to the EF with the session token, mirroring
`invoke.ts` but for the browser client. Called from `handleSendReply` after a
successful **public** reply insert. Fire-and-forget; never throws to the caller.

---

## Data model

**No migration.** No schema change, no types regen.

- `notification_log.notification_type` — free text; write `'ticket_response'`.
- `notification_log.reference_id` — existing uuid column; write
  `ticket_response.id`.
- `notification_log.booking_id` — nullable; write `ticket.booking_id` (may be
  NULL).

---

## Environment / secrets

Reuses existing EF secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `SENDGRID_API_KEY`, the default from-address, the app URL,
`SENTRY_DSN`. No new env vars. Client uses `NEXT_PUBLIC_SUPABASE_URL` (already
public).

---

## Testing

- **Vitest** on the Node mirror `renderTicketResponse`:
  - subject contains the display id
  - reply message is HTML-escaped (injection safety)
  - CTA URL uses the tenant host + `/contact/tickets/{display_id}`
  - branding (primary colour / client name) applied
- **Guard predicate** — extract `shouldNotifyResident(author_type, is_internal)`
  into a pure helper and unit-test it: staff+public → true; resident → false;
  staff+internal → false. Keeps the EF's core gate Node-testable.
- **Manual smoke** (post-deploy):
  1. Public staff reply on a test ticket → resident receives branded email with
     working CTA.
  2. Internal note → no email.
  3. Re-invoke the EF with the same `ticket_response_id` → `skipped`
     (idempotent).
  4. Ticket whose contact has no email → `no_email`, no send, `failed` log row.
- **CI:** mirror-sync (`scripts/sync-mirrors.sh --check`) passes for the new
  auto-discovered pair; the existing `pii-leak.test.ts` still passes (it guards
  dispatcher stdout, not the email body — the resident's own name in the body
  is intended).

---

## Out of scope (future)

- SMS channel for ticket replies.
- Notifying staff when a resident replies, or on new ticket creation.
- Notifying on ticket status changes (resolved / closed).
- Admin retry UI for failed ticket notifications (the existing retry flow is
  booking-shaped; these rows will still be visible in `notification_log`).

---

## Files touched

| Action | File |
|---|---|
| NEW | `supabase/functions/notify-ticket-response/index.ts` |
| NEW | `supabase/functions/_shared/templates/ticket-response.ts` (source of truth) |
| GEN | `src/lib/notifications/templates/ticket-response.ts` (Node mirror — generated by `sync-mirrors.sh`) |
| NEW | `src/__tests__/notifications/templates/ticket-response.test.ts` |
| NEW | `src/lib/notifications/invoke-ticket-response.ts` |
| EDIT | `src/app/(admin)/admin/service-tickets/[id]/admin-ticket-detail-client.tsx` |

`scripts/sync-mirrors.sh` needs **no edit** — the new template is auto-discovered
by its `templates/*.ts` glob.
