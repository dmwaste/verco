import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * VER-186 — Stripe paid-booking E2E.
 *
 * Scope + harness note: this suite runs fully browser-mocked (`page.route` intercepts
 * Supabase REST/Auth/Edge Functions). The high-value, harness-appropriate guard is the
 * **create-checkout contract** — confirm-form (`confirm-form.tsx:355-380`) builds
 * `success_url`/`cancel_url` from the booking ref and POSTs them to the `create-checkout`
 * Edge Function before redirecting the browser to Stripe. A regression that breaks the
 * `success_url` (so Stripe returns to a 404, leaving the resident stranded after paying) is
 * exactly the silent failure this catches — the existing booking-flow test only asserts that
 * create-checkout was *called*, not the contract.
 *
 * NOT covered here (out of reach for a browser-mocked harness, documented for the follow-up):
 *  - The `/booking/[ref]` return page is a **server component** — its Supabase fetch runs in
 *    the Next.js server process, invisible to `page.route`, so its rendered Confirmed/paid
 *    state can't be data-mocked.
 *  - The `stripe-webhook` EF's `Pending Payment → Confirmed` transition + HMAC signature are
 *    server-side; they need a real Supabase (the `test:rls` DB-integration layer is the right
 *    home — tracked as a VER-186 follow-up).
 *
 * The mock setup mirrors `booking-flow.spec.ts` (proven to render the confirm page); once the
 * e2e harness is locally runnable, both should share a `tests/e2e/helpers/booking-mocks.ts`.
 */

// ── Test data ────────────────────────────────────────────

const TEST_PROPERTY = {
  id: '11111111-1111-1111-1111-111111111111',
  collection_area_id: '22222222-2222-2222-2222-222222222222',
  address: '23 Leda Blvd',
  formatted_address: '23 Leda Blvd, Wellard WA 6170',
  has_geocode: false,
  latitude: null,
  longitude: null,
}

const TEST_FY = { id: 'fy-2025-26', label: '2025-26', is_current: true }

const TEST_SERVICES = [
  { id: 'svc-general', name: 'General Waste', category: { name: 'Bulk Collection', code: 'bulk' } },
]

const TEST_ALLOCATION_RULES = [
  { max_collections: 3, category: { name: 'Bulk Collection', code: 'bulk' } },
]

const TEST_SERVICE_RULES_FLAT = [
  { service_id: 'svc-general', max_collections: 3, extra_unit_price: 50 },
]

const TEST_SERVICE_RULES_NESTED = [
  {
    id: 'sr-1', service_id: 'svc-general', max_collections: 3, extra_unit_price: 50,
    collection_area_id: TEST_PROPERTY.collection_area_id,
    service: { id: 'svc-general', name: 'General Waste', category_id: 'cat-bulk', category: { id: 'cat-bulk', name: 'Bulk Collection', code: 'bulk' } },
  },
]

const TEST_COLLECTION_DATE = {
  id: 'cd-1',
  date: '2026-04-15',
  is_open: true,
  for_mud: false,
  bulk_is_closed: false,
  anc_is_closed: false,
  bulk_units_booked: 5,
  bulk_capacity_limit: 100,
  anc_units_booked: 2,
  anc_capacity_limit: 50,
  collection_area_id: TEST_PROPERTY.collection_area_id,
}

/** Server returns this from create-booking on the paid path (4× General = 1 free + 3 paid @ $50). */
const PAID_BOOKING = { booking_id: '33333333-3333-3333-3333-333333333333', ref: 'KWN-1-PAID01', requires_payment: true, total_cents: 5000 }

/** Same-origin stub the browser is redirected to in place of the real Stripe checkout. */
const STRIPE_STUB_PATH = '/__stripe_checkout_stub'

type CapturedCheckout = { booking_id?: string; success_url?: string; cancel_url?: string }

// ── Mocks ────────────────────────────────────────────────

/** Browser-side mocks for the paid confirm flow. Returns a holder that captures the create-checkout body. */
async function setupPaidMocks(page: Page): Promise<{ checkout: CapturedCheckout | null }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'
  const holder: { checkout: CapturedCheckout | null } = { checkout: null }

  await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
    const url = route.request().url()
    const accept = route.request().headers()['accept'] ?? ''
    const isSingle = accept.includes('vnd.pgrst.object')
    const json = (body: unknown, single = false) =>
      route.fulfill({
        status: 200,
        contentType: single ? 'application/vnd.pgrst.object+json' : 'application/json',
        body: JSON.stringify(body),
        headers: single ? { 'Content-Range': '0-0/1' } : {},
      })

    if (url.includes('eligible_properties')) return json([TEST_PROPERTY])
    if (url.includes('financial_year')) return json(isSingle ? TEST_FY : [TEST_FY], isSingle)
    if (url.includes('allocation_rules')) return json(TEST_ALLOCATION_RULES)
    if (url.includes('service_rules')) {
      const nested = url.includes('service') && url.includes('select=')
      return json(nested ? TEST_SERVICE_RULES_NESTED : TEST_SERVICE_RULES_FLAT)
    }
    if (url.includes('/service?') || url.includes('/service&')) return json(TEST_SERVICES)
    if (url.includes('booking_item')) return json([])
    if (url.includes('collection_date')) return json(isSingle ? TEST_COLLECTION_DATE : [TEST_COLLECTION_DATE], isSingle)
    if (url.includes('/booking?') || url.includes('/booking&')) return json([])
    if (url.includes('profiles')) return json(isSingle ? { contact_id: null } : [{ contact_id: null }], isSingle)
    if (url.includes('contacts')) return json(isSingle ? null : [], isSingle)
    return json([])
  })

  await page.route(`${supabaseUrl}/auth/v1/**`, async (route: Route) => {
    const url = route.request().url()
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: null }) })
    if (url.includes('/otp') || url.includes('/token')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'mock-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'mock-refresh', user: { id: 'user-1', email: 'jane@example.com' } }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
  })

  await page.route(`${supabaseUrl}/functions/v1/create-booking`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAID_BOOKING) }),
  )

  // Capture the create-checkout body (the contract under test), then hand back a same-origin
  // stub URL so the browser redirect lands somewhere real instead of leaving for stripe.com.
  await page.route(`${supabaseUrl}/functions/v1/create-checkout`, async (route: Route) => {
    try {
      holder.checkout = route.request().postDataJSON() as CapturedCheckout
    } catch { /* ignore non-JSON */ }
    const origin = new URL(page.url()).origin
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checkout_url: `${origin}${STRIPE_STUB_PATH}` }) })
  })

  // The Stripe-checkout stand-in the browser is redirected to.
  await page.route(`**${STRIPE_STUB_PATH}`, async (route: Route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><h1>Stripe checkout stub</h1></body></html>' }),
  )

  return holder
}

/** Drive the confirm page from a deep link with paid items through OTP. */
async function fillContactAndPay(page: Page, items: string, totalCents: string) {
  const params = new URLSearchParams({
    property_id: TEST_PROPERTY.id,
    collection_area_id: TEST_PROPERTY.collection_area_id,
    address: TEST_PROPERTY.formatted_address,
    items,
    total_cents: totalCents,
    collection_date_id: TEST_COLLECTION_DATE.id,
    location: 'Front Verge',
  })
  await page.goto(`/book/confirm?${params.toString()}`)
  await expect(page.getByText('Confirm Your Booking')).toBeVisible()
  await page.getByPlaceholder('First name').fill('Jane')
  await page.getByPlaceholder('Last name').fill('Smith')
  await page.getByPlaceholder('Email address').fill('jane@example.com')
  await page.getByPlaceholder(/Mobile number/).fill('0412345678')
}

// ── Tests ────────────────────────────────────────────────

test.describe('Paid Booking — Stripe checkout contract', () => {
  test('create-checkout receives correct success/cancel URLs + booking_id, then the browser redirects to Stripe', async ({ page }) => {
    const holder = await setupPaidMocks(page)
    await fillContactAndPay(page, 'svc-general:4', '5000')

    const payButton = page.getByRole('button', { name: 'Proceed to Payment' })
    await expect(payButton).toBeVisible()
    await payButton.click()

    // Guest OTP gate before create-booking/create-checkout
    await expect(page.getByText('Verify Email')).toBeVisible()
    const otpCells = page.locator('input[inputmode="numeric"]')
    for (let i = 0; i < 6; i++) await otpCells.nth(i).fill(String(i + 1))

    // Browser is redirected to the (stubbed) Stripe checkout
    await page.waitForURL(`**${STRIPE_STUB_PATH}`, { timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'Stripe checkout stub' })).toBeVisible()

    // The create-checkout contract — the wiring that gets the resident back after paying
    const origin = new URL(page.url()).origin
    expect(holder.checkout).not.toBeNull()
    expect(holder.checkout!.booking_id).toBe(PAID_BOOKING.booking_id)
    expect(holder.checkout!.success_url).toBe(`${origin}/booking/${PAID_BOOKING.ref}?success=true`)
    expect(holder.checkout!.cancel_url).toBe(`${origin}/booking/${PAID_BOOKING.ref}?cancelled=true`)
  })

  test('the total shown to the resident mirrors the server price (no client/server drift)', async ({ page }) => {
    await setupPaidMocks(page)
    await fillContactAndPay(page, 'svc-general:4', '5000')

    // 3 paid units @ $50 = $50.00 over the free allocation → the brand total bar shows it
    await expect(page.getByTestId('booking-total')).toContainText('$50.00')
    // ...and the CTA is the payment button, not "Confirm Booking"
    await expect(page.getByRole('button', { name: 'Proceed to Payment' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirm Booking' })).toHaveCount(0)
  })
})
