import { test, expect, type Page, type Route } from '@playwright/test'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'

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

// The full crew flow (run picker -> sequenced run sheet -> per-stop closeout
// with rollup) runs server-side (server component fetch + server actions),
// which Playwright route-interception cannot mock. That path is covered by
// the DB integration tests in src/__tests__/rls.test.ts ("collection_stop /
// collection_run_meta") and the pure-logic tests in stop-runs.test.ts /
// stops.test.ts. Here we guard the field-only route boundaries.
test.describe('Field runs (stop model)', () => {
  test('unauthenticated access to /field redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/field')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('unauthenticated access to a run sheet redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/field/runs/2026-06-15/KWN1')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('unauthenticated access to a stop closeout redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/field/stops/00000000-0000-0000-0000-000000000000')
    await expect(page).toHaveURL(/\/auth/)
  })
})
