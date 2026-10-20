# Ops alerts runbook — Verco

Where Verco's watchdogs send "something is wrong" messages, how to connect them to Teams, and how to prove they work.

## What this is

Some background jobs watch for silent failures. When one finds a problem, it posts a short message to **one Teams channel**:

| Job | When | Catches |
|---|---|---|
| `notification-health-check` | Every 3 hours | Email or SMS sends failing, and bookings that never got a confirmation |
| `stale-closeout-check` | Daily, 09:35 | Stops still not closed out 3 days after collection, and bookings that never reached the crews (#575) — see [Stale-closeout alert](#stale-closeout-alert) |

Until #576 that channel was never connected. The watchdog found problems and had nowhere to say them. Now, if the channel is missing or broken, Sentry shows a warning on every run until it's fixed.

Alerts carry counts, channel names (email/SMS), council area codes and booking refs, plus a link into admin. They never include resident names, emails or phone numbers, and any that slip into a provider error message are blanked out before sending.

## One-time setup (Dan)

Do this **after** the release containing #576 is live. Older code sends a format the Teams workflow doesn't expect.

### 1. Create the webhook in Teams

1. In Teams, pick a **standard** (not private) channel the ops team watches, e.g. a new "Verco alerts" channel. Posts to private channels aren't fully supported yet.
2. Next to the channel name: **⋯ → Workflows**.
3. Search for and pick the template **Send webhook alerts to a channel**.
4. Name it `Verco ops alerts`, confirm the team and channel, and **Save**.
5. Leave **Who can trigger the flow** on **Anyone**. The link itself is the password. The tenant-only options need a sign-in token Verco doesn't send.
6. Copy the webhook link it shows you. The link is long and contains `sig=…`. **Treat it like a password: don't paste it into chat, email, a ticket or git.** Anyone holding it can post into that channel.

The workflow runs under the account that created it. If that account is ever disabled, alerts stop. Use an account that will stay around.

### 2. Give the link to Verco

With the link still on your clipboard, run this in a terminal from the `verco` folder:

```bash
pnpm supabase secrets set "OPS_ALERT_WEBHOOK_URL=$(pbpaste)" --project-ref tfddjmplcizfirxqhotv
```

`$(pbpaste)` reads the clipboard, so the link never lands in your shell history. No redeploy is needed.

You don't need `OPS_ALERT_WEBHOOK_FORMAT`. It defaults to `teams`. Set it to `slack` only if the link is ever a Slack incoming webhook instead.

### 3. Send the test alert

In the Supabase dashboard, open **SQL Editor** and run:

```sql
select net.http_post(
  url := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/notification-health-check',
  headers := jsonb_build_object(
    'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_ef_secret' limit 1),
    'Content-Type', 'application/json'
  ),
  body := '{"test_alert": true}'::jsonb,
  timeout_milliseconds := 30000
) as request_id;
```

This calls the watchdog the same way the scheduler does, using the cron key that's already stored in the database. Nothing secret is copied anywhere. It skips the health checks and only sends the test message.

Wait about 5 seconds, then read the answer (swap in the `request_id` the first query returned):

```sql
select status_code, content from net._http_response where id = <request_id>;
```

**Good:** `status_code` is `200` and `content` shows `"delivered":true` with `"status":202`. A card titled **"TEST — Verco ops alert channel check — no action needed"** appears in the channel within a minute.

**Done when you've seen that card in Teams.** An alert path that has never delivered a message is only configured, not working. Close #576 then.

## When the answer isn't good

| What `content` says | What it means | Fix |
|---|---|---|
| `"error":"OPS_ALERT_WEBHOOK_URL is not set"` | Step 2 didn't take | Re-run step 2, then the test |
| `"error":"webhook returned HTTP 401"` or `403` | The workflow only accepts signed-in callers | In the workflow, set **Who can trigger** to **Anyone**, save, retest |
| `"error":"webhook returned HTTP 404"` | The workflow was deleted, turned off, or the link was cut short | Copy the link again (step 1.6), redo step 2 |
| `"error":"webhook returned HTTP 400"` | Teams rejected the message shape | Check `OPS_ALERT_WEBHOOK_FORMAT` isn't `slack`; raise a GitHub issue with the `responseBody` |
| `"error":"OPS_ALERT_WEBHOOK_FORMAT must be …"` | That optional secret has a typo | `pnpm supabase secrets unset OPS_ALERT_WEBHOOK_FORMAT --project-ref tfddjmplcizfirxqhotv` |
| `"error":"webhook POST threw: …"` | Couldn't reach Microsoft (network/timeout) | Retest in a few minutes |
| `Unauthorized (…)` | The test request didn't carry the cron key | Check the query copied in full; `cron_ef_secret` must exist in Vault |
| `200` / `delivered:true`, but no card | Teams accepted it, then the workflow failed | Teams → **Workflows** → `Verco ops alerts` → run history shows why (often the creator's connection needs signing in again) |

## Day to day

- **A real alert** has a red title, e.g. "🚨 Verco notification health alert". It says what failed and links to the admin notification log. A missing confirmation repeats every 3 hours until someone resends it (or it's a day old).
- **If the channel breaks later**, the watchdog returns an error to the scheduler, and Sentry shows a warning starting `notification-health-check: ops alert not sent — …` (or `stale-closeout-check: …`). Fix it with the table above.
- **Until step 2 is done**, Sentry shows `notification-health-check: the watchdog cannot alert — OPS_ALERT_WEBHOOK_URL is not set` every 3 hours. That is deliberate and stops once the link is set.
- **To move alerts to another channel or replace a leaked link:** create a new workflow (step 1), set the secret again (step 2), test (step 3), then delete the old workflow in Teams.

## Stale-closeout alert

Crews close out every stop in the field app. A stop nobody closes out is unbilled, unproven work, and it makes the council's on-time figures look worse than the work done. Cambridge once went two weeks closing out none of its 204 stops before anyone noticed (#568). This alert stops that happening quietly.

**When it posts** (ADR 0034):

- **Most mornings:** only if the collection day **3 days ago** still has stops open, or has a booking that never reached the crews. Each collection day is named once, on the morning it turns 3 days old. Normal closeouts happen the same day, so 3 days means something is wrong.
- **Mondays:** if anything older is still open, it restates the backlog even when nothing new went stale. That way a council that stopped closing out can't drop out of sight.
- **Otherwise:** nothing. Silence means nothing new went stale.

**What it says:**

- **Newly stale:** each council area with stops from that day still open, e.g. `CAM-B: 50 of 50 stops still open, 0 closed out`. A whole area at 0 closed out usually means that council's crews have stopped closing out in the app, not that 50 collections were missed.
- **Not dispatched:** a booking still waiting for collection with no open crew job. Either none was ever created, or a date change cancelled the old job and the new one never appeared, or one of its waste types was never sent out. That's a system fault (the OptimoRoute push), not a crew one. Raise a GitHub issue.
- **Standing backlog:** everything 3+ days old still open, per area, with the date range and how many stops that area *did* close out since then. `0 closed out since …` means the area has gone dark.

**What to do:** open **Worklist** (the bookings from that day still open) or **Full backlog** (everything stale). Admin shows one client at a time, so switch client to see Kwinana vs Verge Valet councils. Then get the crew or supervisor to close the stops out in the field app (only crews can close a stop out). Once they do, the stops drop off the backlog.

**Check what it would say today, without posting** (Supabase **SQL Editor**):

```sql
select net.http_post(
  url := 'https://tfddjmplcizfirxqhotv.supabase.co/functions/v1/stale-closeout-check',
  headers := jsonb_build_object(
    'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_ef_secret' limit 1),
    'Content-Type', 'application/json'
  ),
  body := '{"dry_run": true}'::jsonb,
  timeout_milliseconds := 30000
) as request_id;
```

Read the answer the same way as the test alert. `trigger` is `null` (nothing to say), `newly_stale` or `weekly_backlog`. When it would alert, `alert_text` holds the exact message. Swap the body for `{"test_alert": true}` to send this job's labelled test card to the channel.

**Settings:** `STALE_CLOSEOUT_THRESHOLD_DAYS` (Edge Function secret, default `3`) changes how many days count as stale.

**Turn it off:** `select cron.unschedule('stale-closeout-check');` It only reads data and posts the alert, so there's nothing to undo.

## For developers

Every watchdog alerts through `sendOpsAlert` in `supabase/functions/_shared/ops-alert.ts`. Never add a second sink, and never route alerts through SendGrid or Twilio, since those are among the things being watched.

```ts
const result = await sendOpsAlert(
  { source: 'my-cron-ef', title: '…', lines: ['…'], links: [{ label: '…', url: `${ADMIN_ORIGIN}/admin/…` }] },
  { webhookUrl: Deno.env.get('OPS_ALERT_WEBHOOK_URL'), format: Deno.env.get('OPS_ALERT_WEBHOOK_FORMAT') },
  { captureWarning },
)
```

It never throws. It returns `delivered: true` or a reason (`not_configured`, `invalid_format`, `webhook_failed`), and raises the Sentry warning itself. Pass counts and refs only. Return HTTP 500 from a cron EF when a warranted alert fails, so pg_cron records it. Payload shapes and redaction are covered by `src/__tests__/notifications/ops-alert.test.ts`. The decision is ADR 0033.

The stale-closeout rules (cohort date, backlog grouping, not-dispatched, Monday restatement, wording) live in the pure `supabase/functions/_shared/stale-closeouts.ts`, mirrored to `src/lib/ops/stale-closeouts.ts` and tested in `src/__tests__/ops/stale-closeouts.test.ts`. The Edge Function only queries and sends.
