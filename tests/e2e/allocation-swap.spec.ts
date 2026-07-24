import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Allocation swap (Kwinana: 3 Ancillary -> 1 Green) — full wizard walk.
 * Mocks Supabase REST so no real backend is needed (same approach as
 * booking-flow.spec.ts). Verifies: the swap checkbox shows when eligible,
 * ticking it disables the ancillary steppers, and the swap flag carries
 * through EVERY step (services -> date -> details -> confirm) so the confirm
 * breakdown prices the swapped Green as free. Regression: the date/details
 * steps rebuild the query string from a whitelist and used to drop `swap`,
 * so confirm silently re-priced the swapped Green as a paid extra.
 */

const AREA = '22222222-2222-2222-2222-222222222222'
const PROPERTY = {
  id: '11111111-1111-1111-1111-111111111111',
  collection_area_id: AREA,
  address: '64 Crabtree Way',
  formatted_address: '64 Crabtree Way, Medina WA 6167',
  is_mud: false,
  unit_count: 0,
}
const FY = { id: 'fy-2025-26', label: '2025-26', is_current: true }

const ALLOCATION_RULES = [
  { max_collections: 2, category: { code: 'bulk' } },
  { max_collections: 3, category: { code: 'anc' } },
]
const SERVICE_RULES_NESTED = [
  {
    id: 'sr-g', service_id: 'svc-general', max_collections: 2, extra_unit_price: 89.67,
    collection_area_id: AREA,
    service: { id: 'svc-general', name: 'General', category_id: 'cat-bulk', category: { id: 'cat-bulk', name: 'Bulk', code: 'bulk' } },
  },
  {
    id: 'sr-green', service_id: 'svc-green', max_collections: 2, extra_unit_price: 89.67,
    collection_area_id: AREA,
    service: { id: 'svc-green', name: 'Green', category_id: 'cat-bulk', category: { id: 'cat-bulk', name: 'Bulk', code: 'bulk' } },
  },
  {
    id: 'sr-m', service_id: 'svc-mattress', max_collections: 1, extra_unit_price: 45,
    collection_area_id: AREA,
    service: { id: 'svc-mattress', name: 'Mattress', category_id: 'cat-anc', category: { id: 'cat-anc', name: 'Ancillary', code: 'anc' } },
  },
]
const CONVERSION_RULE = [{
  id: 'conv-1', from_units: 3, to_units: 1, to_service_id: 'svc-green',
  from_allocation_rules: { collection_area_id: AREA, category: { code: 'anc' } },
  to_allocation_rules: { category: { code: 'bulk' } },
}]

// Services list (date-step needed-buckets + confirm-page names)
const SERVICES = [
  { id: 'svc-general', name: 'General', category: { name: 'Bulk', code: 'bulk' } },
  { id: 'svc-green', name: 'Green', category: { name: 'Bulk', code: 'bulk' } },
  { id: 'svc-mattress', name: 'Mattress', category: { name: 'Ancillary', code: 'anc' } },
]

const COLLECTION_DATE = {
  id: 'cd-1',
  date: '2027-03-15',
  is_open: true,
  for_mud: false,
  bulk_is_closed: false,
  anc_is_closed: false,
  bulk_units_booked: 0,
  bulk_capacity_limit: 100,
  anc_units_booked: 0,
  anc_capacity_limit: 50,
  collection_area_id: AREA,
}

async function setupMocks(page: Page, opts: { fyUsageRows?: unknown[] } = {}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'
  await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
    const url = route.request().url()
    const accept = route.request().headers()['accept'] ?? ''
    const single = accept.includes('vnd.pgrst.object')
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({
        status: 200,
        contentType: single ? 'application/vnd.pgrst.object+json' : 'application/json',
        body: JSON.stringify(body),
        headers,
      })

    if (url.includes('eligible_properties')) return json(single ? PROPERTY : [PROPERTY])
    if (url.includes('financial_year')) return json(single ? FY : [FY])
    if (url.includes('allocation_conversion_rule')) return json(CONVERSION_RULE)
    // FY usage RPC — the sole source of prior usage AND applied-swap state
    // (an existing swap surfaces as a ('swap', <rule_id>, 1) row; the
    // allocation_swap table itself is never read by the /book flow any more).
    if (url.includes('get_property_fy_usage')) return json(opts.fyUsageRows ?? [])
    if (url.includes('allocation_rules')) return json(ALLOCATION_RULES)
    if (url.includes('service_rules')) return json(SERVICE_RULES_NESTED)
    // collection_date first — its URL also contains `collection_area_id=eq...`,
    // so a bare 'collection_area' substring match would swallow it.
    if (url.includes('collection_date')) return json(single ? COLLECTION_DATE : [COLLECTION_DATE])
    // confirm-page tenant brand: collection_area → client(service_name, terms_markdown)
    if (url.includes('/collection_area?') && url.includes('client')) {
      const row = { client: { service_name: null, terms_markdown: null } }
      return json(single ? row : [row])
    }
    // date-step pool membership: collection_area → capacity_pool_id (null = unpooled)
    if (url.includes('/collection_area?')) {
      const row = { id: AREA, capacity_pool_id: null }
      return json(single ? row : [row])
    }
    if (url.includes('/service?') || url.includes('/service&')) return json(SERVICES)
    if (url.includes('booking_item')) return json([]) // 0 prior usage
    return json([])
  })
}

test.describe('Allocation swap — wizard flow', () => {
  test('swap flag carries services → date → details → confirm; swapped Green prices free', async ({ page }) => {
    await setupMocks(page)
    await page.goto(
      `/book/services?property_id=${PROPERTY.id}&collection_area_id=${AREA}&address=${encodeURIComponent(PROPERTY.formatted_address)}`
    )

    // Both category sections render. The bulk section label is tenant-dependent
    // ('Bulk collection' for most tenants, 'Collection' for Verge Valet) — match
    // either, anchored so it doesn't catch 'Ancillary collection' or checkbox copy.
    await expect(page.getByText(/^(Bulk collection|Collection)$/)).toBeVisible()
    await expect(page.getByText('Ancillary collection', { exact: true })).toBeVisible()

    // The swap checkbox is offered (eligible: rule + 0 ancillary used + no swap).
    await expect(page.getByText(/Swap your 3 ancillary collections/i)).toBeVisible()

    // Stepper "+" buttons in DOM order: 0=General, 1=Green, 2=Mattress(anc).
    const plus = page.getByRole('button', { name: '+', exact: true })

    // Tick the swap → checked, and the ancillary (Mattress) stepper disables.
    const checkbox = page.getByRole('checkbox')
    await checkbox.check()
    await expect(checkbox).toBeChecked()
    await expect(plus.nth(2)).toBeDisabled()

    // Add THREE Green. Only 2 are free on base rules (green service max 2, bulk
    // category max 2) — the 3rd is free purely via the swap (+1 to both budgets).
    await plus.nth(1).click()
    await plus.nth(1).click()
    await plus.nth(1).click()
    await page.getByRole('button', { name: /Next Step/i }).click()

    // The swap flag carries to the date step.
    await expect(page).toHaveURL(/\/book\/date\?.*swap=true/)

    // Date step: pick the available date and continue — swap must survive the hop.
    await page.getByRole('button', { name: /available/i }).first().click()
    await page.getByRole('button', { name: /Next Step/i }).click()
    await expect(page).toHaveURL(/\/book\/details\?.*swap=true/)

    // Details step: default location (Front Verge) is fine — continue.
    await page.getByRole('button', { name: /Next Step/i }).click()
    await expect(page).toHaveURL(/\/book\/confirm\?.*swap=true/)

    // Confirm: the breakdown honours the swap — banner shown, 3rd Green NOT charged.
    await expect(page.getByText(/Ancillary allocation swapped/i)).toBeVisible()
    await expect(page.getByTestId('booking-total')).toHaveText('No Charge')
  })

  /**
   * Regression (24/07/2026, 19 McNairn Cross / 41 Shipwright Ave): a swap
   * applied EARLIER this FY was only read to hide the checkbox — the pricing
   * surfaces never applied its budget shift on subsequent bookings. The
   * forfeited 3 Ancillary reappeared as free (badge "3 of 3", free e-waste /
   * mattress) and the swap-granted extra Green was charged. Design §2: the
   * forfeiture lasts the whole FY.
   */
  test('existing swap: no checkbox, note shown, ancillary paid, granted Green free', async ({ page }) => {
    await setupMocks(page, {
      fyUsageRows: [
        // The swap booking already consumed 1 Green (the granted unit's twin
        // scenario in prod), plus the swap marker row.
        { usage_kind: 'service', usage_key: 'svc-green', units: 1 },
        { usage_kind: 'category', usage_key: 'bulk', units: 1 },
        { usage_kind: 'swap', usage_key: 'conv-1', units: 1 },
      ],
    })
    await page.goto(
      `/book/services?property_id=${PROPERTY.id}&collection_area_id=${AREA}&address=${encodeURIComponent(PROPERTY.formatted_address)}`
    )

    // The already-swapped note renders; the opt-in checkbox does NOT.
    await expect(page.getByText(/have been swapped for 1 extra green waste/i)).toBeVisible()
    await expect(page.getByRole('checkbox')).toHaveCount(0)

    // Post-swap budgets: Ancillary zeroed, Bulk granted +1 (1 already used).
    await expect(page.getByText('0 of 0 remaining')).toBeVisible()
    await expect(page.getByText('2 of 3 remaining')).toBeVisible()

    const plus = page.getByRole('button', { name: '+', exact: true })

    // Ancillary is forfeited → adding a Mattress prices as a PAID extra.
    await plus.nth(2).click()
    await expect(page.getByText(/1 extra mattress @ \$45\.00 each/i)).toBeVisible()
    await expect(page.getByText('Total extra services cost')).toBeVisible()

    // Remove it again — cart back to free-only.
    const minus = page.getByRole('button', { name: '−', exact: true })
    await minus.nth(2).click()
    await expect(page.getByText('Total extra services cost')).toHaveCount(0)

    // Two more Green: green svc max 2+1(swap)=3 minus 1 used = 2 free; bulk
    // cat 2+1(swap)=3 minus 1 used = 2 free. Both free — the granted extra
    // Green must NOT be charged (this was the "charged for the 3rd green" bug).
    await plus.nth(1).click()
    await plus.nth(1).click()
    await expect(page.getByText('Total extra services cost')).toHaveCount(0)
    await page.getByRole('button', { name: /Next Step/i }).click()

    // No swap=true in the URL — this booking does NOT request a new swap.
    await expect(page).toHaveURL(/\/book\/date\?/)
    expect(page.url()).not.toContain('swap=true')

    await page.getByRole('button', { name: /available/i }).first().click()
    await page.getByRole('button', { name: /Next Step/i }).click()
    await expect(page).toHaveURL(/\/book\/details\?/)
    await page.getByRole('button', { name: /Next Step/i }).click()
    await expect(page).toHaveURL(/\/book\/confirm\?/)

    // Confirm: existing-swap banner wording + nothing charged.
    await expect(page.getByText(/swapped for an extra green waste collection earlier/i)).toBeVisible()
    await expect(page.getByTestId('booking-total')).toHaveText('No Charge')
  })
})
