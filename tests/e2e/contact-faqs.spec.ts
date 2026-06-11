import { test, expect } from '@playwright/test'

/**
 * Contact page FAQ accordion — interaction + accessibility contract.
 *
 * Runs against the dev server's real tenant data (RSC fetches happen
 * server-side, so page.route cannot mock them — table RENDERING is covered
 * deterministically in src/__tests__/faq-answer.test.tsx). This spec pins the
 * behaviour that holds for any FAQ content: expand/collapse, aria wiring,
 * inert collapsed panels, and the absence of the old 500px clip cap.
 */
test.describe('contact page FAQs', () => {
  test('accordion expands with correct a11y semantics and no height cap', async ({ page }) => {
    await page.goto('/contact')

    const toggles = page.locator('button[aria-controls^="faq-panel-"]')
    await expect(toggles.first()).toBeVisible()
    const count = await toggles.count()
    expect(count).toBeGreaterThan(0)

    const first = toggles.first()
    const panel = page.locator('#faq-panel-0')

    // Collapsed: aria says closed, panel is inert (links unreachable by keyboard)
    await expect(first).toHaveAttribute('aria-expanded', 'false')
    await expect(panel).toHaveAttribute('inert', '')

    // Expand: aria flips, inert lifts, answer content is actually visible
    await first.click()
    await expect(first).toHaveAttribute('aria-expanded', 'true')
    await expect(panel).not.toHaveAttribute('inert', '')
    await expect(panel.locator('div').last()).toBeVisible()

    // The old fixed clip cap must be gone — full-height answers depend on it
    const maxHeight = await panel.evaluate((el) => el.style.maxHeight)
    expect(maxHeight).toBe('')

    // Single-open semantics: opening the second closes the first
    if (count > 1) {
      await toggles.nth(1).click()
      await expect(first).toHaveAttribute('aria-expanded', 'false')
      await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'true')
    }
  })
})
