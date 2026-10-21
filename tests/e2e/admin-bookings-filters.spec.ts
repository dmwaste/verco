import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Multi-select filters on the admin bookings list (VER-323).
 *
 * WHERE EACH GUARANTEE IS TESTED (same split as admin-stuck-closeouts.spec.ts:
 * CI's E2E job has only the anon key against OTP-only auth, so a logged-in
 * walk can't run there):
 *
 * 1. Tick / untick / group-tick / clear behaviour —
 *    src/__tests__/admin-multi-select-filter.test.tsx (every PR).
 * 2. URL parsing (comma-joined values, old single-value links, junk dropped),
 *    council grouping — src/__tests__/bookings/list-filters.test.ts.
 * 3. The auth boundary — HERE: a multi-value filter URL is still guarded.
 * 4. The logged-in walk — HERE, seeded-or-skip: a comma-joined deep link lands
 *    with both statuses ticked, and an old single-value link still works.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'

async function mockNoSession(page: Page) {
  await page.route(`${supabaseUrl}/auth/v1/**`, async (route: Route) => {
    const url = route.request().url()
    if (url.includes('/user')) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'No session' }) })
    }
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant' }) })
  })
}

/** Open the list; skip when there is no staff session to render it. */
async function gotoBookingsOrSkip(page: Page, query: string): Promise<boolean> {
  await page.goto(`/admin/bookings?${query}`)
  await page.waitForLoadState('networkidle')
  if (new URL(page.url()).pathname !== '/admin/bookings') {
    test.skip(true, 'No staff session — skipping (runs against seeded/preview data with a staff login)')
    return false
  }
  return true
}

test.describe('Bookings filters — route boundary', () => {
  test('a multi-value filter URL still redirects an anonymous visitor to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/bookings?status=Completed,Non-conformance,Nothing%20Presented&date_from=2026-09-01&date_to=2026-09-30')
    await expect(page).toHaveURL(/\/auth/)
  })
})

test.describe('Bookings filters — staff list (seeded)', () => {
  test('a comma-joined status link lands with both statuses ticked', async ({ page }) => {
    if (!(await gotoBookingsOrSkip(page, 'status=Completed,Nothing%20Presented'))) return

    const trigger = page.getByRole('button', { name: 'Filter by status' })
    await expect(trigger).toHaveText(/^2 statuses/)
    await trigger.click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Completed' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('menuitemcheckbox', { name: 'Nothing Presented' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('menuitemcheckbox', { name: 'Cancelled' })).toHaveAttribute('aria-checked', 'false')

    // Ticking a third keeps the menu open and widens the filter.
    await page.getByRole('menuitemcheckbox', { name: 'Non-conformance' }).click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Non-conformance' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(trigger).toHaveText(/^3 statuses/)
  })

  test('an old single-value link is the one-item case', async ({ page }) => {
    if (!(await gotoBookingsOrSkip(page, 'status=Scheduled'))) return
    await expect(page.getByRole('button', { name: 'Filter by status' })).toHaveText(/^Scheduled/)
  })
})
