import { test, expect, type Page, type Route } from '@playwright/test'

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

const TEST_CLIENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const TEST_FY = { id: 'fy-2025-26', label: '2025-26', is_current: true }

const TEST_SERVICES = [
  { id: 'svc-general', name: 'General Waste', category: { name: 'Bulk Collection', code: 'bulk' } },
  { id: 'svc-green', name: 'Green Waste', category: { name: 'Bulk Collection', code: 'bulk' } },
  { id: 'svc-mattress', name: 'Mattress', category: { name: 'Ancillary', code: 'anc' } },
]

const TEST_ALLOCATION_RULES = [
  { max_collections: 3, category: { name: 'Bulk Collection', code: 'bulk' } },
  { max_collections: 2, category: { name: 'Ancillary', code: 'anc' } },
]

// Flat service_rules (used by confirm page summary)
const TEST_SERVICE_RULES_FLAT = [
  { service_id: 'svc-general', max_collections: 3, extra_unit_price: 50 },
  { service_id: 'svc-green', max_collections: 3, extra_unit_price: 40 },
  { service_id: 'svc-mattress', max_collections: 2, extra_unit_price: 60 },
]

// Nested service_rules with service join (used by services form: select *, service!inner(...))
const TEST_SERVICE_RULES_NESTED = [
  {
    id: 'sr-1', service_id: 'svc-general', max_collections: 3, extra_unit_price: 50,
    collection_area_id: TEST_PROPERTY.collection_area_id,
    service: { id: 'svc-general', name: 'General Waste', category_id: 'cat-bulk', category: { id: 'cat-bulk', name: 'Bulk Collection', code: 'bulk' } },
  },
  {
    id: 'sr-2', service_id: 'svc-green', max_collections: 3, extra_unit_price: 40,
    collection_area_id: TEST_PROPERTY.collection_area_id,
    service: { id: 'svc-green', name: 'Green Waste', category_id: 'cat-bulk', category: { id: 'cat-bulk', name: 'Bulk Collection', code: 'bulk' } },
  },
  {
    id: 'sr-3', service_id: 'svc-mattress', max_collections: 2, extra_unit_price: 60,
    collection_area_id: TEST_PROPERTY.collection_area_id,
    service: { id: 'svc-mattress', name: 'Mattress', category_id: 'cat-anc', category: { id: 'cat-anc', name: 'Ancillary', code: 'anc' } },
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

// ── Helpers ──────────────────────────────────────────────

/** Set up network interceptors for Supabase REST and Edge Functions */
async function setupMocks(page: Page, options?: {
  priorUsage?: Array<{ service_id: string; no_services: number }>
  createBookingResult?: Record<string, unknown>
  inactiveArea?: boolean
  /** When set, the client's terms_markdown — drives the T&Cs acceptance gate. */
  clientTerms?: string
}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'

  // Intercept Supabase REST API calls
  await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
    const url = route.request().url()

    // collection_area → client brand (confirm-form: service_name + terms_markdown).
    // Drives the T&Cs acceptance gate. options.clientTerms (or null = no terms).
    // Matches the `/collection_area?select=client:client_id(...)` endpoint only —
    // NOT eligible_properties' embedded collection_area, nor the date-form area-pool
    // query (which selects no client).
    if (url.includes('/collection_area?') && url.includes('client')) {
      const accept = route.request().headers()['accept'] ?? ''
      const isSingle = accept.includes('vnd.pgrst.object')
      const row = { client: { service_name: null, terms_markdown: options?.clientTerms ?? null } }
      return route.fulfill({
        status: 200,
        contentType: isSingle ? 'application/vnd.pgrst.object+json' : 'application/json',
        body: JSON.stringify(isSingle ? row : [row]),
      })
    }

    // eligible_properties — embed the area's go-live flag so the WS-A gate can read it
    if (url.includes('eligible_properties')) {
      const property = {
        ...TEST_PROPERTY,
        collection_area: { client_id: TEST_CLIENT_ID, is_active: !options?.inactiveArea },
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([property]),
      })
    }

    // financial_year
    if (url.includes('financial_year')) {
      // .single() uses Accept: application/vnd.pgrst.object+json
      const accept = route.request().headers()['accept'] ?? ''
      const isSingle = accept.includes('vnd.pgrst.object')
      return route.fulfill({
        status: 200,
        contentType: isSingle ? 'application/vnd.pgrst.object+json' : 'application/json',
        body: JSON.stringify(isSingle ? TEST_FY : [TEST_FY]),
        headers: { 'Content-Range': '0-0/1' },
      })
    }

    // allocation_rules
    if (url.includes('allocation_rules')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TEST_ALLOCATION_RULES),
      })
    }

    // service_rules — return nested shape if query includes service join (wildcard select)
    if (url.includes('service_rules')) {
      const isNestedQuery = url.includes('service') && url.includes('select=')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(isNestedQuery ? TEST_SERVICE_RULES_NESTED : TEST_SERVICE_RULES_FLAT),
      })
    }

    // service (without _rules)
    if (url.includes('/service?') || url.includes('/service&')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TEST_SERVICES),
      })
    }

    // booking_item (usage)
    if (url.includes('booking_item')) {
      const usageData = (options?.priorUsage ?? []).map((u) => ({
        ...u,
        service: TEST_SERVICES.find((s) => s.id === u.service_id) ?? TEST_SERVICES[0],
        booking: { property_id: TEST_PROPERTY.id, fy_id: TEST_FY.id, status: 'Submitted' },
      }))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(usageData),
      })
    }

    // collection_date
    if (url.includes('collection_date')) {
      const accept = route.request().headers()['accept'] ?? ''
      const isSingle = accept.includes('vnd.pgrst.object')
      if (isSingle) {
        return route.fulfill({
          status: 200,
          contentType: 'application/vnd.pgrst.object+json',
          body: JSON.stringify(TEST_COLLECTION_DATE),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([TEST_COLLECTION_DATE]),
      })
    }

    // booking (history)
    if (url.includes('/booking?') || url.includes('/booking&')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    }

    // profiles
    if (url.includes('profiles')) {
      const accept = route.request().headers()['accept'] ?? ''
      const isSingle = accept.includes('vnd.pgrst.object')
      return route.fulfill({
        status: 200,
        contentType: isSingle ? 'application/vnd.pgrst.object+json' : 'application/json',
        body: JSON.stringify(isSingle ? { contact_id: null } : [{ contact_id: null }]),
      })
    }

    // contacts
    if (url.includes('contacts')) {
      const accept = route.request().headers()['accept'] ?? ''
      const isSingle = accept.includes('vnd.pgrst.object')
      return route.fulfill({
        status: isSingle ? 200 : 200,
        contentType: isSingle ? 'application/vnd.pgrst.object+json' : 'application/json',
        body: JSON.stringify(isSingle ? null : []),
      })
    }

    // Default passthrough
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    })
  })

  // Intercept Supabase Auth API
  await page.route(`${supabaseUrl}/auth/v1/**`, async (route: Route) => {
    const url = route.request().url()

    if (url.includes('/user')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: null }),
      })
    }

    if (url.includes('/otp') || url.includes('/token')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-token',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'mock-refresh',
          user: { id: 'user-1', email: 'jane@example.com' },
        }),
      })
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    })
  })

  // Intercept Edge Functions
  await page.route(`${supabaseUrl}/functions/v1/create-booking`, async (route: Route) => {
    const result = options?.createBookingResult ?? {
      booking_id: 'booking-1',
      ref: 'KWN-1-A7K9M2',
      requires_payment: false,
      total_cents: 0,
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(result),
    })
  })

  await page.route(`${supabaseUrl}/functions/v1/create-checkout`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ checkout_url: 'https://checkout.stripe.com/mock-session' }),
    })
  })

  // Google Places proxy
  await page.route(`${supabaseUrl}/functions/v1/google-places-proxy**`, async (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        predictions: [
          {
            place_id: 'place-1',
            description: '23 Leda Blvd, Wellard WA 6170',
          },
        ],
      }),
    })
  })
}

// ── Tests ────────────────────────────────────────────────

test.describe('Booking Flow', () => {
  test('free booking — full wizard flow', async ({ page }) => {
    await setupMocks(page)

    // Step 1: Address
    await page.goto('/book')
    await expect(page.getByRole('heading', { name: 'Book a Collection' })).toBeVisible()

    // Type address and select from autocomplete
    const addressInput = page.getByPlaceholder('Start typing your address...')
    await addressInput.fill('23 Leda')
    // Wait for autocomplete suggestion and click it
    await page.getByText('23 Leda Blvd, Wellard WA 6170').click()

    // Wait for property found banner
    await expect(page.getByText('Property found!')).toBeVisible()

    // Click continue
    await page.getByRole('button', { name: /Book new collection/i }).click()

    // Step 2: Services
    await expect(page).toHaveURL(/\/book\/services/)
    await expect(page.getByText('Select services')).toBeVisible()

    // Increment General Waste to 1
    const incrementButtons = page.locator('button:has-text("+")').first()
    await incrementButtons.click()

    // Click Next Step
    await page.getByRole('button', { name: /Next step/i }).click()

    // Step 3: Date
    await expect(page).toHaveURL(/\/book\/date/)

    // Select the first available date in the calendar (cells are labelled by status)
    const dateButton = page.getByRole('button', { name: /available/i }).first()
    await dateButton.click()

    await page.getByRole('button', { name: /Next step/i }).click()

    // Step 4: Details
    await expect(page).toHaveURL(/\/book\/details/)

    // Front Verge should be default, just click Next
    await page.getByRole('button', { name: /Next step/i }).click()

    // Step 5: Confirm
    await expect(page).toHaveURL(/\/book\/confirm/)
    await expect(page.getByText('Confirm Your Booking')).toBeVisible()

    // Fill contact details
    await page.getByPlaceholder('First name').fill('Jane')
    await page.getByPlaceholder('Last name').fill('Smith')
    await page.getByPlaceholder('Email address').fill('jane@example.com')
    await page.getByPlaceholder(/Mobile number/).fill('0412345678')

    // Verify total shows "No Charge" (free booking — nothing to pay)
    await expect(page.getByTestId('booking-total')).toHaveText('No Charge')

    // Verify button says "Confirm Booking"
    const confirmButton = page.getByRole('button', { name: 'Confirm Booking' })
    await expect(confirmButton).toBeVisible()

    // Track create-booking call
    let createBookingPayload: Record<string, unknown> | null = null
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'
    page.on('request', async (req) => {
      if (req.url().includes('create-booking') && req.method() === 'POST') {
        try {
          createBookingPayload = req.postDataJSON()
        } catch { /* ignore */ }
      }
    })

    // Submit
    await confirmButton.click()

    // OTP step should appear for guest
    await expect(page.getByText('Verify Email')).toBeVisible()

    // Enter OTP digits
    const otpCells = page.locator('input[inputmode="numeric"]')
    for (let i = 0; i < 6; i++) {
      await otpCells.nth(i).fill(String(i + 1))
    }

    // Wait for booking creation call to complete
    await page.waitForResponse(
      (resp) => resp.url().includes('create-booking') && resp.status() === 200,
      { timeout: 10000 },
    )

    // Verify the create-booking Edge Function was called with correct payload
    expect(createBookingPayload).not.toBeNull()
    expect(createBookingPayload!.property_id).toBe(TEST_PROPERTY.id)
    expect(createBookingPayload!.collection_date_id).toBe(TEST_COLLECTION_DATE.id)
    expect(createBookingPayload!.location).toBe('Front Verge')
    expect((createBookingPayload!.contact as Record<string, string>).email).toBe('jane@example.com')
    expect((createBookingPayload!.items as Array<Record<string, unknown>>)).toHaveLength(1)
  })

  test('client with T&Cs — acceptance dialog gates submit, then booking proceeds', async ({ page }) => {
    await setupMocks(page, { clientTerms: '## Terms & Conditions\n\nYou agree to the rules.' })

    // Walk the wizard to the confirm step (same path as the free-booking flow)
    await page.goto('/book')
    await page.getByPlaceholder('Start typing your address...').fill('23 Leda')
    await page.getByText('23 Leda Blvd, Wellard WA 6170').click()
    await expect(page.getByText('Property found!')).toBeVisible()
    await page.getByRole('button', { name: /Book new collection/i }).click()

    await expect(page).toHaveURL(/\/book\/services/)
    await page.locator('button:has-text("+")').first().click()
    await page.getByRole('button', { name: /Next step/i }).click()

    await expect(page).toHaveURL(/\/book\/date/)
    await page.getByRole('button', { name: /available/i }).first().click()
    await page.getByRole('button', { name: /Next step/i }).click()

    await expect(page).toHaveURL(/\/book\/details/)
    await page.getByRole('button', { name: /Next step/i }).click()

    await expect(page).toHaveURL(/\/book\/confirm/)
    await page.getByPlaceholder('First name').fill('Jane')
    await page.getByPlaceholder('Last name').fill('Smith')
    await page.getByPlaceholder('Email address').fill('jane@example.com')
    await page.getByPlaceholder(/Mobile number/).fill('0412345678')

    let createBookingPayload: Record<string, unknown> | null = null
    page.on('request', (req) => {
      if (req.url().includes('create-booking') && req.method() === 'POST') {
        try { createBookingPayload = req.postDataJSON() } catch { /* ignore */ }
      }
    })

    // Clicking Confirm must open the T&Cs dialog BEFORE the guest OTP step.
    await page.getByRole('button', { name: 'Confirm Booking' }).click()
    await expect(page.getByRole('heading', { name: 'Terms & Conditions' })).toBeVisible()
    await expect(page.getByText('You agree to the rules.')).toBeVisible()
    await expect(page.getByText('Verify Email')).toBeHidden()

    // Accept is disabled until the checkbox is ticked.
    const acceptButton = page.getByRole('button', { name: /Accept & continue/i })
    await expect(acceptButton).toBeDisabled()
    await page.getByLabel(/I have read and accept/i).check()
    await acceptButton.click()

    // Now the guest OTP step appears; completing it submits with terms_accepted: true.
    await expect(page.getByText('Verify Email')).toBeVisible()
    const otpCells = page.locator('input[inputmode="numeric"]')
    for (let i = 0; i < 6; i++) {
      await otpCells.nth(i).fill(String(i + 1))
    }

    await page.waitForResponse(
      (resp) => resp.url().includes('create-booking') && resp.status() === 200,
      { timeout: 10000 },
    )
    expect(createBookingPayload).not.toBeNull()
    expect(createBookingPayload!.terms_accepted).toBe(true)
  })

  test('paid booking — shows payment button and calls create-checkout', async ({ page }) => {
    let createBookingCalled = false
    let createCheckoutCalled = false

    await setupMocks(page, {
      createBookingResult: {
        booking_id: 'booking-2',
        ref: 'KWN-1-B8L0N3',
        requires_payment: true,
        total_cents: 5000,
      },
    })

    // Track Edge Function calls
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'
    page.on('request', (req) => {
      if (req.url().includes('create-booking')) createBookingCalled = true
      if (req.url().includes('create-checkout')) createCheckoutCalled = true
    })

    // Navigate directly to confirm step with paid total
    const params = new URLSearchParams({
      property_id: TEST_PROPERTY.id,
      collection_area_id: TEST_PROPERTY.collection_area_id,
      address: TEST_PROPERTY.formatted_address,
      items: 'svc-general:4',
      total_cents: '5000',
      collection_date_id: TEST_COLLECTION_DATE.id,
      location: 'Front Verge',
    })
    await page.goto(`/book/confirm?${params.toString()}`)

    await expect(page.getByText('Confirm Your Booking')).toBeVisible()

    // Fill contact
    await page.getByPlaceholder('First name').fill('Jane')
    await page.getByPlaceholder('Last name').fill('Smith')
    await page.getByPlaceholder('Email address').fill('jane@example.com')
    await page.getByPlaceholder(/Mobile number/).fill('0412345678')

    // Verify total block shows $50.00 (the large accent-coloured text in the brand total bar)
    await expect(page.getByTestId('booking-total')).toContainText('$50.00')

    // Verify button says "Proceed to Payment"
    const payButton = page.getByRole('button', { name: 'Proceed to Payment' })
    await expect(payButton).toBeVisible()
    await payButton.click()

    // OTP step
    await expect(page.getByText('Verify Email')).toBeVisible()
    const otpCells = page.locator('input[inputmode="numeric"]')
    for (let i = 0; i < 6; i++) {
      await otpCells.nth(i).fill(String(i + 1))
    }

    // Wait for the Stripe redirect (intercepted)
    await page.waitForTimeout(2000)
    expect(createBookingCalled).toBe(true)
    expect(createCheckoutCalled).toBe(true)
  })

  test('mixed cart — free and paid items with correct breakdown', async ({ page }) => {
    // 1x General Waste (free, within allocation) + 1x Mattress (paid, ancillary exhausted)
    // total_cents = 6000 (1 mattress @ $60)
    await setupMocks(page, {
      priorUsage: [
        // Ancillary category fully used — mattress will be paid
        { service_id: 'svc-mattress', no_services: 2 },
      ],
      createBookingResult: {
        booking_id: 'booking-3',
        ref: 'KWN-1-C9M1P4',
        requires_payment: true,
        total_cents: 6000,
      },
    })

    // Navigate directly to confirm step with mixed items
    const params = new URLSearchParams({
      property_id: TEST_PROPERTY.id,
      collection_area_id: TEST_PROPERTY.collection_area_id,
      address: TEST_PROPERTY.formatted_address,
      items: 'svc-general:1,svc-mattress:1',
      total_cents: '6000',
      collection_date_id: TEST_COLLECTION_DATE.id,
      location: 'Front Verge',
    })
    await page.goto(`/book/confirm?${params.toString()}`)

    await expect(page.getByText('Confirm Your Booking')).toBeVisible()

    // Fill contact
    await page.getByPlaceholder('First name').fill('Jane')
    await page.getByPlaceholder('Last name').fill('Smith')
    await page.getByPlaceholder('Email address').fill('jane@example.com')
    await page.getByPlaceholder(/Mobile number/).fill('0412345678')

    // Verify "Included in allocation" section shows the free item under the
    // Service/Qty/Amount table (per-row "Included" badge retired for a Qty column).
    await expect(page.getByText('Included in allocation')).toBeVisible()
    await expect(page.getByText(/General Waste/)).toBeVisible()
    await expect(page.getByText('Qty', { exact: true })).toBeVisible()

    // Verify "Extra services" section shows the paid item
    await expect(page.getByText('Extra services')).toBeVisible()
    await expect(page.getByText(/Mattress/).first()).toBeVisible()

    // Verify total block shows $60.00
    await expect(page.getByTestId('booking-total')).toContainText('$60.00')

    // Verify payment button (not "Confirm Booking")
    await expect(page.getByRole('button', { name: 'Proceed to Payment' })).toBeVisible()

    // Track create-booking payload
    let createBookingPayload: Record<string, unknown> | null = null
    page.on('request', async (req) => {
      if (req.url().includes('create-booking') && req.method() === 'POST') {
        try { createBookingPayload = req.postDataJSON() } catch { /* ignore */ }
      }
    })

    // Submit
    await page.getByRole('button', { name: 'Proceed to Payment' }).click()

    // OTP
    await expect(page.getByText('Verify Email')).toBeVisible()
    const otpCells = page.locator('input[inputmode="numeric"]')
    for (let i = 0; i < 6; i++) {
      await otpCells.nth(i).fill(String(i + 1))
    }

    // Wait for booking creation
    await page.waitForResponse(
      (resp) => resp.url().includes('create-booking') && resp.status() === 200,
      { timeout: 10000 },
    )

    // Verify payload has both items
    expect(createBookingPayload).not.toBeNull()
    const items = createBookingPayload!.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    expect(items.find((i) => i.service_id === 'svc-general')).toBeDefined()
    expect(items.find((i) => i.service_id === 'svc-mattress')).toBeDefined()
  })

  test('held-back council — inactive area shows "not yet available" and blocks booking', async ({ page }) => {
    await setupMocks(page, { inactiveArea: true })

    await page.goto('/book')
    const addressInput = page.getByPlaceholder('Start typing your address...')
    await addressInput.fill('23 Leda')
    await page.getByText('23 Leda Blvd, Wellard WA 6170').click()

    // WS-A gate (VER-269): the area resolves but is_active=false, so the resident
    // sees "not yet available" — not "Property found!" and no continue button.
    await expect(page.getByText('Not yet available online')).toBeVisible()
    await expect(page.getByText('Property found!')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Book new collection/i })).toHaveCount(0)
  })
})
