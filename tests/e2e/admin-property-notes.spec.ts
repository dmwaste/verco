import { test, expect, type Page } from '@playwright/test'

// E2E for property notes & permission-to-enter forms (ADR 0031). The admin
// property page is SERVER-rendered from real data (notes, signed file links),
// so — like admin-quantity-edit.spec.ts — each test skips gracefully when the
// server has no seeded property for this id. Seed an eligible property with
// this id (in the admin's current client) to exercise the specs; they WRITE a
// note through the real server action, so only run seeded against dev/preview.
const TEST_PROPERTY_ID = '00000000-0000-4000-8000-000000031001'

/** The Notes & documents card — scoping avoids "Add Allocation" and Next's route announcer (role=alert). */
function notesSection(page: Page) {
  return page.locator('div.rounded-xl', { has: page.getByRole('heading', { name: 'Notes & documents' }) })
}

async function gotoPropertyOrSkip(page: Page): Promise<boolean> {
  await page.goto(`/admin/properties/${TEST_PROPERTY_ID}`)
  await page.waitForLoadState('networkidle')
  if (!page.url().includes(TEST_PROPERTY_ID)) {
    test.skip(true, 'No seeded property — skipping (runs against seeded/preview data)')
    return false
  }
  return true
}

test.describe('Property notes & documents (ADR 0031)', () => {
  test('a permission-to-enter form cannot be saved without its file', async ({ page }) => {
    if (!(await gotoPropertyOrSkip(page))) return

    const section = notesSection(page)
    await expect(section.getByRole('heading', { name: 'Notes & documents' })).toBeVisible()
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await section.getByLabel(/Details/).fill('Signed by the owner')
    await section.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(section.getByRole('alert')).toContainText('Attach the signed permission-to-enter form')
  })

  test('staff add a note, see it listed, then remove it', async ({ page }) => {
    if (!(await gotoPropertyOrSkip(page))) return

    const section = notesSection(page)
    const text = `E2E note ${Date.now()}`
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await section.getByLabel('Type').selectOption('note')
    await section.getByLabel('Note', { exact: true }).fill(text)
    await section.getByRole('button', { name: 'Save', exact: true }).click()

    const entry = section.getByRole('listitem').filter({ hasText: text })
    await expect(entry).toBeVisible()

    page.once('dialog', (d) => void d.accept())
    await entry.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(section.getByText(text)).toHaveCount(0)
  })
})
