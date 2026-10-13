// scripts/send-reminder-catchup.ts
/**
 * Late collection reminders for open bookings the daily cron missed.
 *
 * Selects Confirmed/Scheduled bookings whose reminder day has arrived but whose
 * collection is still ahead, with no collection_reminder sent on any channel
 * (rules in lib/reminder-catchup). Bookings on a shared/staff contact are held
 * back so a reminder can't reach the wrong person. Each send goes through
 * `send-notification` — the same template (it names the real collection date)
 * and the same per-channel idempotency key as the cron, so a re-run or an
 * overlapping cron tick can never double-send.
 *
 * Called from outside the edge runtime on purpose: Supabase rate-limits one
 * edge function calling another, which is what cut the 13/10 cron runs short.
 *
 * Usage:
 *   set -a; . /path/to/.env.local; set +a
 *   npx tsx scripts/send-reminder-catchup.ts           # dry-run: counts only
 *   npx tsx scripts/send-reminder-catchup.ts --apply   # send
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseFlags, requireEnv } from './lib/cli'
import { pagedIn } from './lib/db'
import { isSharedContact, planReminderCatchup, reminderDue, type CatchupBooking } from './lib/reminder-catchup'

const PAGE = 1000
const CONCURRENCY = 4

interface BookingRow {
  id: string
  ref: string
  type: string
  contact_id: string | null
  client_id: string
  booking_item: Array<{ collection_date: { date: string } | null }>
}

function awstToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function loadOpenBookings(verco: SupabaseClient, clients: Map<string, { slug: string; days: number }>) {
  const out: CatchupBooking[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await verco
      .from('booking')
      .select('id, ref, type, contact_id, client_id, booking_item(collection_date(date))')
      .in('status', ['Confirmed', 'Scheduled'])
      .in('client_id', [...clients.keys()])
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load booking: ${error.message}`)
    const rows = (data ?? []) as unknown as BookingRow[]
    for (const r of rows) {
      const client = clients.get(r.client_id)
      if (!client) continue
      out.push({
        id: r.id,
        ref: r.ref,
        clientSlug: client.slug,
        reminderDays: client.days,
        type: r.type,
        contactId: r.contact_id,
        dates: r.booking_item.map((i) => i.collection_date?.date).filter((d): d is string => !!d),
      })
    }
    if (rows.length < PAGE) break
  }
  return out
}

async function main() {
  const flags = parseFlags(process.argv)
  const apply = !!flags.apply
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const verco = createClient(supabaseUrl, serviceKey)
  const today = awstToday()

  console.log(`Reminder catch-up — today ${today} AWST (${apply ? 'APPLY' : 'DRY RUN'})`)

  const { data: clientRows, error: clientErr } = await verco
    .from('client')
    .select('id, slug, sms_reminder_days_before')
    .not('sms_reminder_days_before', 'is', null)
  if (clientErr) throw new Error(`load client: ${clientErr.message}`)
  const clients = new Map(
    (clientRows ?? []).map((c) => [c.id as string, { slug: c.slug as string, days: c.sms_reminder_days_before as number }]),
  )

  const bookings = await loadOpenBookings(verco, clients)
  const due = reminderDue(bookings, today)
  const dueIds = due.map((b) => b.id)

  const sentRows = await pagedIn<{ booking_id: string }>(verco, 'notification_log', 'booking_id', 'booking_id', dueIds, (q) =>
    q.eq('notification_type', 'collection_reminder').eq('status', 'sent'),
  )
  const alreadyReminded = new Set(sentRows.map((r) => r.booking_id))

  const contactIds = [...new Set(due.map((b) => b.contactId).filter((c): c is string => !!c))]
  const contacts = await pagedIn<{ id: string; email: string | null }>(verco, 'contacts', 'id, email', 'id', contactIds)
  const shared = new Set(contacts.filter((c) => isSharedContact(c.id, c.email)).map((c) => c.id))

  const plan = planReminderCatchup(bookings, today, alreadyReminded, shared)

  const tally = new Map<string, number>()
  for (const b of plan.send) {
    const key = `${b.clientSlug.padEnd(11)} collection ${b.earliest}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  console.log(`\nOpen bookings: ${bookings.length} · reminder due: ${due.length} · already reminded: ${alreadyReminded.size}`)
  console.log(`Held back (shared/staff contact): ${plan.excludedSharedContact.length}${plan.excludedSharedContact.length ? ` — ${plan.excludedSharedContact.map((b) => b.ref).join(', ')}` : ''}`)
  console.log(`To send: ${plan.send.length}`)
  for (const [k, n] of [...tally].sort()) console.log(`  ${k}: ${n}`)

  if (!apply) {
    console.log(`\nDRY RUN — nothing sent. Re-run with --apply to send ${plan.send.length} reminders.`)
    return
  }

  // send-notification returns the EMAIL channel's result, so an email 'skipped'
  // can still mean the SMS went out — count accepted calls, then verify per
  // channel in notification_log.
  const result = { accepted: 0, failed: 0 }
  const failures: string[] = []
  const queue = [...plan.send]
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'collection_reminder', booking_id: b.id }),
          signal: AbortSignal.timeout(30_000),
        })
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || body.ok === false) {
          result.failed++
          failures.push(`${b.ref}: HTTP ${res.status} ${body.error ?? ''}`.trim())
        } else result.accepted++
      } catch (err) {
        result.failed++
        failures.push(`${b.ref}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`\nAccepted by send-notification: ${result.accepted} · failed: ${result.failed} (check notification_log for per-channel delivery)`)
  for (const f of failures) console.log(`  FAILED ${f}`)
  if (result.failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
