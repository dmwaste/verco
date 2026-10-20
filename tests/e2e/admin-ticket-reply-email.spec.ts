import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Ticket reply "Resend email" banner (#671 / #689).
 *
 * WHERE EACH GUARANTEE IS TESTED — read before extending this file.
 * The ticket page is SERVER-rendered behind the (admin) layout's
 * `supabase.auth.getUser()` guard, which page.route() cannot mock, and CI's
 * E2E job carries only the anon key against an OTP-only auth config — so the
 * logged-in walk cannot execute there. Coverage lands where each guarantee is
 * enforced:
 *
 * 1. Banner states (not_sent → Resend offered; no_email → notice only) and the
 *    Resend re-invoke — component render in
 *    src/__tests__/admin-ticket-reply-email-status.test.tsx (every PR).
 * 2. EF outcome → banner reason (sent/skipped ok, no_email, anything else
 *    not_sent; gateway retries) —
 *    src/__tests__/notifications/invoke-ticket-response.test.ts.
 * 3. The 23505 double-send guard behind Retry on /admin/notifications ("already
 *    gone out", never a raw constraint error) —
 *    src/__tests__/notifications/retry-notification-action.test.ts. That Retry
 *    is a SERVER action calling the retry_notification_log RPC server-side:
 *    not interceptable from the browser, and clicking it in a seeded run would
 *    email a resident (closeout-correction precedent: never from E2E), so it
 *    is deliberately not driven here.
 * 4. The auth boundary — HERE, through the real proxy + layout guard in a real
 *    browser: neither a ticket nor the notifications log is reachable
 *    anonymously, and no reply/log data — nor a notify-ticket-response call —
 *    is issued for that visitor.
 * 5. The logged-in walk — HERE, seeded-or-skip (like
 *    admin-quantity-edit.spec.ts): against a seeded dev/preview with a staff
 *    session. The reply insert, profile read, status update and the
 *    notify-ticket-response Edge Function are all CLIENT-side calls, so they
 *    are mocked — nothing is written to the seeded ticket and no email is
 *    sent — and the banner is driven through its real states.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'

/** The id the mocked reply insert hands back; every notify call must carry it. */
const REPLY_ID = '00000000-0000-4000-8000-000000689001'

/** What the mocked Edge Function reports, in call order (`sent` once the list runs out). */
type EfStatus = 'sent' | 'failed' | 'no_email'

/** Mock Supabase auth to return no session (unauthenticated). */
async function mockNoSession(page: Page) {
  await page.route(`${supabaseUrl}/auth/v1/**`, async (route: Route) => {
    const url = route.request().url()
    if (url.includes('/user')) {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'No session' }),
      })
    }
    return route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid_grant' }),
    })
  })
}

/**
 * Mock the ticket page's client-side writes and the notify EF. Everything else
 * (the list, audit reads, the real session) passes through, so a seeded run
 * renders real data but never changes it. A 200 with a non-`sent` status is
 * final for postWithRetry — no gateway back-off sleeps in the test.
 */
async function setupTicketMocks(page: Page, outcomes: EfStatus[]) {
  const efCalls: Array<{ ticket_response_id?: string }> = []
  const queue = [...outcomes]

  await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
    const url = route.request().url()
    const method = route.request().method()
    const accept = route.request().headers()['accept'] ?? ''
    const single = accept.includes('vnd.pgrst.object')

    if (url.includes('/ticket_response') && method === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/vnd.pgrst.object+json',
        body: JSON.stringify({ id: REPLY_ID, created_at: new Date().toISOString() }),
      })
    }
    if (url.includes('/profiles') && single) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.pgrst.object+json',
        body: JSON.stringify({ display_name: 'E2E Staff' }),
      })
    }
    if (url.includes('/service_ticket') && method === 'PATCH') {
      return route.fulfill({ status: 204, body: '' })
    }
    return route.continue()
  })

  await page.route(`${supabaseUrl}/functions/v1/notify-ticket-response`, async (route: Route) => {
    efCalls.push(route.request().postDataJSON() as { ticket_response_id?: string })
    const status: EfStatus = queue.shift() ?? 'sent'
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status }) })
  })

  return { efCalls }
}

/** Open the first seeded ticket; return false (and skip) without a staff session or a ticket. */
async function gotoTicketOrSkip(page: Page): Promise<boolean> {
  await page.goto('/admin/service-tickets')
  await page.waitForLoadState('networkidle')
  if (new URL(page.url()).pathname !== '/admin/service-tickets') {
    test.skip(true, 'No staff session — skipping (runs against seeded/preview data with a staff login)')
    return false
  }
  const first = page.locator('a[href^="/admin/service-tickets/"]').first()
  await first.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (!(await first.isVisible())) {
    test.skip(true, 'No seeded ticket — skipping')
    return false
  }
  await first.click()
  await expect(page).toHaveURL(/\/admin\/service-tickets\/[^/?]+/)
  return true
}

async function sendPublicReply(page: Page) {
  await page.getByRole('button', { name: 'Reply to Resident' }).click()
  await page.getByPlaceholder('Write a reply to the resident...').fill('E2E reply — email outcome check')
  await page.getByRole('button', { name: 'Send Reply' }).click()
}

/** The warning strip under the composer — role=status, scoped by its copy. */
function emailBanner(page: Page) {
  return page.getByRole('status').filter({ hasText: /Your reply is saved/ })
}

test.describe('Ticket reply email — route boundary', () => {
  test('unauthenticated access to a ticket redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/service-tickets/TKT-E2E-0001')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('unauthenticated access to the notifications log redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/notifications')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('no reply or log data, and no notify call, for an unauthenticated browser', async ({ page }) => {
    await mockNoSession(page)
    const restCalls: string[] = []
    const efCalls: string[] = []
    await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
      restCalls.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.route(`${supabaseUrl}/functions/v1/notify-ticket-response`, async (route: Route) => {
      efCalls.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"sent"}' })
    })

    await page.goto('/admin/service-tickets/TKT-E2E-0001')
    await expect(page).toHaveURL(/\/auth/)
    await page.goto('/admin/notifications')
    await expect(page).toHaveURL(/\/auth/)

    expect(restCalls.filter((u) => u.includes('ticket_response') || u.includes('notification_log'))).toEqual([])
    expect(efCalls).toEqual([])
  })
})

test.describe('Ticket reply email — staff ticket page (seeded)', () => {
  test('a reply whose email did not send shows the banner; Resend clears it once it goes out', async ({ page }) => {
    const { efCalls } = await setupTicketMocks(page, ['failed', 'sent'])
    if (!(await gotoTicketOrSkip(page))) return

    await sendPublicReply(page)

    const banner = emailBanner(page)
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(/the email to the resident didn.t send/)
    const resend = banner.getByRole('button', { name: 'Resend email' })
    await expect(resend).toBeEnabled()

    await resend.click()

    // Success state: the email went out on the second attempt, so the warning goes away.
    await expect(banner).toHaveCount(0)
    expect(efCalls).toEqual([{ ticket_response_id: REPLY_ID }, { ticket_response_id: REPLY_ID }])
  })

  test('Resend keeps the banner, with the button re-armed, while the email still does not go out', async ({ page }) => {
    const { efCalls } = await setupTicketMocks(page, ['failed', 'failed'])
    if (!(await gotoTicketOrSkip(page))) return

    await sendPublicReply(page)

    const banner = emailBanner(page)
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Resend email' }).click()

    await expect(banner).toBeVisible()
    await expect(banner.getByRole('button', { name: 'Resend email' })).toBeEnabled()
    expect(efCalls).toHaveLength(2)
  })

  test('a resident with no email on file gets the notice and nothing to resend', async ({ page }) => {
    const { efCalls } = await setupTicketMocks(page, ['no_email'])
    if (!(await gotoTicketOrSkip(page))) return

    await sendPublicReply(page)

    const banner = emailBanner(page)
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(/has no email address on file/)
    await expect(banner.getByRole('button', { name: 'Resend email' })).toHaveCount(0)
    expect(efCalls).toHaveLength(1)
  })
})
