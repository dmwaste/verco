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

// The full ranger flow (GPS capture -> photo upload -> create_id_booking RPC ->
// run sheet -> complete) runs server-side (server component fetch + server
// action), which Playwright route-interception cannot mock. That path is
// covered by the DB integration test in src/__tests__/rls.test.ts
// ("Illegal Dumping RPC"). Here we guard the ranger-only route boundary.
test.describe('Illegal Dumping', () => {
  test('unauthenticated access to /field/illegal-dumping/new redirects to /auth', async ({
    page,
  }) => {
    await mockNoSession(page)
    await page.goto('/field/illegal-dumping/new')
    await expect(page).toHaveURL(/\/auth/)
  })
})
