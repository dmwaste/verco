import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * "Stuck closeouts (N)" strip on the admin dashboard (#575 / #688).
 *
 * WHERE EACH GUARANTEE IS TESTED — read before extending this file.
 * The dashboard is SERVER-rendered: the count is a head/count query on
 * `booking` (status Scheduled, collection date ≤ today−3 in AWST, pinned to
 * the current admin client) made in src/app/(admin)/admin/page.tsx, and the
 * strip renders only when the session role passes isContractorStaff(). None
 * of that passes through page.route(), and CI's E2E job carries only the anon
 * key against an OTP-only auth config, so a logged-in walk cannot execute
 * there. Coverage lands where each guarantee is enforced:
 *
 * 1. Count → copy → link, incl. "renders nothing at zero" and the singular —
 *    src/__tests__/stuck-closeouts-callout.test.tsx (every PR).
 * 2. Contractor-only — isContractorStaff in src/__tests__/roles.test.ts; the
 *    page passes `isContractor ? stuckQuery : null`, so a client-tier admin
 *    never gets a count at all.
 * 3. The worklist URL the strip shares with the daily Teams alert —
 *    worklistUrl in src/__tests__/ops/stale-closeouts.test.ts.
 * 4. The auth boundary — HERE, through the real proxy + (admin) layout guard
 *    in a real browser: neither the dashboard nor the stale worklist is
 *    reachable anonymously, and no booking data is issued to that visitor.
 * 5. The logged-in walk — HERE, seeded-or-skip (like
 *    admin-quantity-edit.spec.ts): against a seeded dev/preview with a
 *    contractor session, the strip's count, copy and link are checked and
 *    following the link must land on the bookings list with the Scheduled +
 *    collection-date-to filters already applied. Whether the strip shows is
 *    decided by the seed, so each walk skips when its precondition isn't met.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'

/** DEFAULT_STALE_THRESHOLD_DAYS in src/lib/ops/stale-closeouts.ts. */
const STALE_THRESHOLD_DAYS = 3

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

/** AWST (UTC+8, no DST) calendar date `daysAgo` days before now — the page's own maths. */
function awstDateDaysAgo(daysAgo: number): string {
  const ms = Date.now() + 8 * 60 * 60 * 1000 - daysAgo * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

function stripLink(page: Page) {
  return page.getByRole('link', { name: /Stuck closeouts \(\d+\)/ })
}

/** Open the dashboard; return false (and skip) when there is no staff session to render it. */
async function gotoDashboardOrSkip(page: Page): Promise<boolean> {
  await page.goto('/admin')
  await page.waitForLoadState('networkidle')
  if (new URL(page.url()).pathname !== '/admin') {
    test.skip(true, 'No staff session — skipping (runs against seeded/preview data with a contractor login)')
    return false
  }
  return true
}

test.describe('Stuck closeouts strip — route boundary', () => {
  test('unauthenticated access to the stale worklist redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/bookings?status=Scheduled&date_to=2026-10-17')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('no booking data reaches an unauthenticated browser from the dashboard', async ({ page }) => {
    await mockNoSession(page)
    const restCalls: string[] = []
    await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
      restCalls.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/auth/)
    // The strip's count is a `booking` head query; nothing on the dashboard may
    // ask for bookings on behalf of a visitor who was never let in.
    expect(restCalls.filter((u) => u.includes('/booking'))).toEqual([])
  })
})

test.describe('Stuck closeouts strip — contractor dashboard (seeded)', () => {
  test('the strip names the count and opens the worklist with the stale filter applied', async ({ page }) => {
    if (!(await gotoDashboardOrSkip(page))) return

    const strip = stripLink(page)
    if ((await strip.count()) === 0) {
      test.skip(true, 'Nothing stuck in the seeded data — the strip is correctly absent (see the zero-count spec)')
      return
    }

    const text = (await strip.textContent()) ?? ''
    const count = Number(/Stuck closeouts \((\d+)\)/.exec(text)?.[1])
    expect(count).toBeGreaterThan(0)
    expect(text).toContain(
      `${count} ${count === 1 ? 'booking' : 'bookings'} ${STALE_THRESHOLD_DAYS}+ days past collection, not closed out`,
    )

    // The cutoff is today−3 in AWST; tolerate a midnight tick between the
    // server render and this assertion.
    const href = (await strip.getAttribute('href')) ?? ''
    const cutoff = new URL(href, 'http://localhost').searchParams.get('date_to') ?? ''
    expect([awstDateDaysAgo(STALE_THRESHOLD_DAYS), awstDateDaysAgo(STALE_THRESHOLD_DAYS + 1)]).toContain(cutoff)
    expect(href).toBe(`/admin/bookings?status=Scheduled&date_to=${cutoff}`)

    await strip.click()
    await expect(page).toHaveURL(/\/admin\/bookings\?/)
    const landed = new URL(page.url()).searchParams
    expect(landed.get('status')).toBe('Scheduled')
    expect(landed.get('date_to')).toBe(cutoff)
    // The list picks its filters up from the URL, so the count and the list agree.
    // Status is a multi-select (VER-323): its trigger names the single ticked value.
    await expect(page.getByRole('button', { name: 'Filter by status' })).toHaveText(/^Scheduled/)
    await expect(page.getByLabel('Collection date to')).toHaveValue(cutoff)
  })

  test('the strip is absent when nothing is stuck', async ({ page }) => {
    if (!(await gotoDashboardOrSkip(page))) return

    if ((await stripLink(page).count()) > 0) {
      test.skip(true, 'The seeded data has stuck bookings — covered by the previous spec')
      return
    }

    await expect(page.getByText(/Stuck closeouts/)).toHaveCount(0)
    // …and the dashboard itself rendered, so the absence is the zero case, not a blank page.
    await expect(page.getByRole('link', { name: /New Booking/ })).toBeVisible()
  })
})
