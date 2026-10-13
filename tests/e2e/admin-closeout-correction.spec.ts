import { test, expect, type Page } from '@playwright/test'

// E2E for the office closeout correction (ADR 0030). The admin booking-detail
// page is SERVER-rendered (booking, stops and corrections are fetched at
// render time), so — like admin-quantity-edit.spec.ts — without seed data the
// server redirects and each test skips. Seed a COMPLETED booking with this id,
// collected within the last 7 days, to exercise it.
//
// Deliberately never SUBMITS a correction: the server action calls the real
// RPC and emails the resident, which page.route() cannot intercept.
const TEST_BOOKING_ID = '00000000-0000-4000-8000-000000300001'

async function gotoBookingOrSkip(page: Page): Promise<boolean> {
  await page.goto(`/admin/bookings/${TEST_BOOKING_ID}`)
  await page.waitForLoadState('networkidle')
  if (!page.url().includes(TEST_BOOKING_ID)) {
    test.skip(true, 'No seeded booking — skipping (runs against seeded/preview data)')
    return false
  }
  return true
}

test.describe('Office closeout correction (ADR 0030)', () => {
  test('a contractor admin can open the correction and must give the reasons', async ({ page }) => {
    if (!(await gotoBookingOrSkip(page))) return

    await page.getByRole('button', { name: 'Correct outcome' }).first().click()
    await page.getByRole('radio', { name: 'Non-conformance' }).check()
    await expect(page.getByText(/can dispute it within 14 days/)).toBeVisible()

    const submit = page.getByRole('button', { name: 'Correct outcome' }).last()
    await expect(submit).toBeDisabled()

    await page.getByLabel('Non-conformance reason').selectOption({ index: 1 })
    await expect(submit).toBeDisabled()
    await page.getByLabel(/Why are you correcting this/).fill('E2E check — not submitted')
    await expect(submit).toBeEnabled()
  })
})
