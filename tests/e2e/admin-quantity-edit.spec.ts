import { test, expect, type Page, type Route } from '@playwright/test'

// E2E for the admin inline quantity editor + contractor date-override dropdown
// (#390.1, feature #380 / #378). The admin booking-detail page is SERVER-
// rendered, so — like ncn-detail.spec.ts — page.route() can only mock the
// client-side calls (Supabase REST from client components, Edge Functions). The
// server fetches the booking at render time; without seeded data the server
// redirects, so each test skips gracefully. Real coverage runs against a dev
// server with seed data or a preview deployment.

// Valid UUID (booking.id is a uuid PK) so a seeded environment CAN contain this
// booking — a non-UUID id here made the seeded escape-hatch unreachable and
// every spec skip forever. Seed a booking with this id to exercise the specs.
const TEST_BOOKING_ID = '00000000-0000-4000-8000-000000390001'
const SERVICE_NAME = 'Mattress'

const TEST_AVAILABLE_DATES_OPEN = [
  { id: 'cd-future-1', date: '2026-08-20', is_open: true, bulk_capacity_limit: 100, bulk_units_booked: 5, bulk_is_closed: false, anc_capacity_limit: 100, anc_units_booked: 0, anc_is_closed: false, id_capacity_limit: 0, id_units_booked: 0, id_is_closed: false },
]
// A closed + a past date — only a contractor's relaxed query should surface
// these. The past date sits inside the contractor 90-day floor (#390.3): the
// production query would never return anything older, so the fixture must not
// either.
const PAST_IN_WINDOW = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!
const TEST_DATES_CLOSED_AND_PAST = [
  ...TEST_AVAILABLE_DATES_OPEN,
  { id: 'cd-closed-1', date: '2026-08-27', is_open: false, bulk_capacity_limit: 100, bulk_units_booked: 5, bulk_is_closed: false, anc_capacity_limit: 100, anc_units_booked: 0, anc_is_closed: false, id_capacity_limit: 0, id_units_booked: 0, id_is_closed: false },
  { id: 'cd-past-1', date: PAST_IN_WINDOW, is_open: true, bulk_capacity_limit: 100, bulk_units_booked: 5, bulk_is_closed: false, anc_capacity_limit: 100, anc_units_booked: 0, anc_is_closed: false, id_capacity_limit: 0, id_units_booked: 0, id_is_closed: false },
]

/** Mock the client-side calls the booking-detail page makes; the server render itself is not mockable. */
async function setupAdminMocks(page: Page, opts: { role?: string; dates?: unknown[] } = {}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'
  const role = opts.role ?? 'contractor-admin'
  // Captured collection_date REST URLs so a test can assert the query SHAPE
  // (role branch + #390.3 window) rather than the returned rows — that regresses
  // the filter logic regardless of what fixture data comes back.
  const collectionDateUrls: string[] = []

  await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
    const url = route.request().url()

    if (url.includes('/rpc/current_user_role')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(role) })
    }
    if (url.includes('collection_date')) {
      collectionDateUrls.push(url)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.dates ?? TEST_AVAILABLE_DATES_OPEN) })
    }
    if (url.includes('auth')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'admin-1', email: 'admin@example.com', role } }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  })

  // The reduction refund fires through the create-booking + process-refund EFs
  // inside the server action — SERVER-side fetches, so page.route() CANNOT
  // intercept them. These mocks only catch any future client-side EF calls.
  // A seeded run therefore exercises the REAL EFs end-to-end: only run seeded
  // e2e against environments on Stripe TEST keys.
  await page.route(`${supabaseUrl}/functions/v1/create-booking`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ booking_id: TEST_BOOKING_ID, ref: 'KWN-1-QTY001', edited: true, requires_payment: false, refund_owed_cents: 5000 }) }),
  )
  await page.route(`${supabaseUrl}/functions/v1/process-refund`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stripe_refund_id: 're_1', stripe_refund_ids: ['re_1'] }) }),
  )

  return { collectionDateUrls }
}

/** ISO yyyy-mm-dd `days` before now (UTC), matching the app's date maths. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!
}

/** The plain `collection_date` table query (not `collection_date_pool`). */
function pickCollectionDateUrl(urls: string[]): string | undefined {
  return urls.find((u) => u.includes('/collection_date?') && !u.includes('collection_date_pool'))
}

/** Navigate to the booking; return false (and skip) if the server has no seed data for it. */
async function gotoBookingOrSkip(page: Page): Promise<boolean> {
  await page.goto(`/admin/bookings/${TEST_BOOKING_ID}`)
  await page.waitForLoadState('networkidle')
  if (!page.url().includes(TEST_BOOKING_ID)) {
    test.skip(true, 'No seeded booking — skipping (runs against seeded/preview data)')
    return false
  }
  return true
}

test.describe('Admin inline quantity editor (#380)', () => {
  test('opens the editor, steppers adjust the quantity, Save enables on change', async ({ page }) => {
    await setupAdminMocks(page)
    if (!(await gotoBookingOrSkip(page))) return

    const openBtn = page.getByLabel('Edit quantities')
    await expect(openBtn).toBeVisible()
    await openBtn.click()

    const decrease = page.getByLabel(`Decrease ${SERVICE_NAME}`)
    await expect(decrease).toBeVisible()
    await decrease.click()

    // Editor Save (scoped to the editing panel) becomes enabled once quantity changed.
    const save = page.getByRole('button', { name: 'Save' }).last()
    await expect(save).toBeEnabled()
  })

  test('a reduction shows a refund banner (initiated / awaiting approval)', async ({ page }) => {
    await setupAdminMocks(page)
    if (!(await gotoBookingOrSkip(page))) return

    await page.getByLabel('Edit quantities').click()
    await page.getByLabel(`Decrease ${SERVICE_NAME}`).click()
    await page.getByRole('button', { name: 'Save' }).last().click()

    // role="status" banner; copy depends on whether process-refund accepted
    // (initiated) or queued it for an admin. Either is a success outcome.
    const banner = page.getByRole('status')
    await expect(banner).toContainText(/refund of \$.*(has been initiated|awaiting admin approval)/i)
  })
})

test.describe('Contractor date-override dropdown (#378)', () => {
  test('contractor sees closed + past dates in the reschedule picker', async ({ page }) => {
    await setupAdminMocks(page, { role: 'contractor-admin', dates: TEST_DATES_CLOSED_AND_PAST })
    if (!(await gotoBookingOrSkip(page))) return

    // Open the collection-details editor (pencil on the Collection Details card).
    await page.getByLabel(/edit collection details/i).click()
    const options = page.locator('select option')
    // The relaxed contractor query returns closed/past dates, flagged in the label.
    await expect(options.filter({ hasText: /closed|past/i }).first()).toBeVisible()
  })

  test('client-admin keeps the open/future-only picker (no closed or past)', async ({ page }) => {
    // A client-tier admin uses the resident filter (is_open + date >= today), so
    // even when the mock offers closed/past rows the query would exclude them.
    await setupAdminMocks(page, { role: 'client-admin', dates: TEST_AVAILABLE_DATES_OPEN })
    if (!(await gotoBookingOrSkip(page))) return

    await page.getByLabel(/edit collection details/i).click()
    const options = page.locator('select option')
    await expect(options.filter({ hasText: /closed|past/i })).toHaveCount(0)
  })
})

// Assert on the intercepted collection_date REQUEST URL, not the returned rows.
// This regresses the role branch + #390.3 past-date window in the query itself,
// so it holds regardless of what fixture data the mock returns. NOTE: the role
// branch (`isContractor`) is derived from the SERVER-rendered session role, not
// the client mock — a seeded run must be logged in AS the role each test names.
test.describe('Reschedule date query shape (role branch + #390.3 window)', () => {
  test('client-admin query filters is_open=eq.true and date>=today', async ({ page }) => {
    const { collectionDateUrls } = await setupAdminMocks(page, { role: 'client-admin' })
    if (!(await gotoBookingOrSkip(page))) return

    await page.getByLabel(/edit collection details/i).click()
    await expect.poll(() => (pickCollectionDateUrl(collectionDateUrls) ? 1 : 0)).toBeGreaterThan(0)

    const url = pickCollectionDateUrl(collectionDateUrls)!
    expect(url).toContain('is_open=eq.true')
    // date=gte.<today> — tolerate a UTC-midnight tick between app render and assert.
    expect(url.includes(`date=gte.${isoDaysAgo(0)}`) || url.includes(`date=gte.${isoDaysAgo(1)}`)).toBe(true)
  })

  test('contractor query drops is_open and floors date at ~90 days ago', async ({ page }) => {
    const { collectionDateUrls } = await setupAdminMocks(page, { role: 'contractor-admin' })
    if (!(await gotoBookingOrSkip(page))) return

    await page.getByLabel(/edit collection details/i).click()
    await expect.poll(() => (pickCollectionDateUrl(collectionDateUrls) ? 1 : 0)).toBeGreaterThan(0)

    const url = pickCollectionDateUrl(collectionDateUrls)!
    // No is_open FILTER (the column still appears in the select list, so match the
    // `=eq.` filter form specifically, not the bare column name).
    expect(url).not.toContain('is_open=eq.')
    // date=gte.<~90-day floor>, NOT today — proves the #390.3 relaxed window.
    expect(url.includes(`date=gte.${isoDaysAgo(90)}`) || url.includes(`date=gte.${isoDaysAgo(91)}`)).toBe(true)
  })
})
