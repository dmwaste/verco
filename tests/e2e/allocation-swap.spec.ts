import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Allocation swap (Kwinana: 3 Ancillary -> 1 Green) — services-step interaction.
 * Mocks Supabase REST so no real backend is needed (same approach as
 * booking-flow.spec.ts). Verifies: the swap checkbox shows when eligible,
 * ticking it disables the ancillary steppers, and the swap flag carries onward.
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

async function setupMocks(page: Page) {
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
    // head:true count query for allocation_swap → count 0 via Content-Range
    if (url.includes('allocation_swap')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]', headers: { 'content-range': '*/0' } })
    }
    if (url.includes('allocation_rules')) return json(ALLOCATION_RULES)
    if (url.includes('service_rules')) return json(SERVICE_RULES_NESTED)
    if (url.includes('booking_item')) return json([]) // 0 prior usage
    return json([])
  })
}

test.describe('Allocation swap — services step', () => {
  test('checkbox appears, disables ancillary, and carries the swap flag', async ({ page }) => {
    await setupMocks(page)
    await page.goto(
      `/book/services?property_id=${PROPERTY.id}&collection_area_id=${AREA}&address=${encodeURIComponent(PROPERTY.formatted_address)}`
    )

    // Both category sections render (exact, to avoid matching the checkbox copy).
    await expect(page.getByText('Bulk Collection', { exact: true })).toBeVisible()
    await expect(page.getByText('Ancillary Collection', { exact: true })).toBeVisible()

    // The swap checkbox is offered (eligible: rule + 0 ancillary used + no swap).
    await expect(page.getByText(/Swap your 3 ancillary collections/i)).toBeVisible()

    // Stepper "+" buttons in DOM order: 0=General, 1=Green, 2=Mattress(anc).
    const plus = page.getByRole('button', { name: '+', exact: true })

    // Tick the swap → checked, and the ancillary (Mattress) stepper disables.
    const checkbox = page.getByRole('checkbox')
    await checkbox.check()
    await expect(checkbox).toBeChecked()
    await expect(plus.nth(2)).toBeDisabled()

    // Add a Green (free via the swap) and continue.
    await plus.nth(1).click()
    await page.getByRole('button', { name: /Next Step/i }).click()

    // The swap flag carries to the date step.
    await expect(page).toHaveURL(/\/book\/date\?.*swap=true/)
  })
})
