import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Admin reports — E2E route boundary (VER-296).
 *
 * WHERE EACH VER-296 GUARANTEE IS TESTED — read before extending this file.
 * The proxy's auth gate runs SERVER-SIDE (`supabase.auth.getUser()` in
 * src/proxy.ts), which Playwright route-interception cannot mock, and CI's
 * E2E job carries only the anon key against an OTP-only auth config — so a
 * genuine logged-in walk cannot execute here. The coverage therefore lands
 * at the layer where each guarantee is actually enforced:
 *
 * 1. Two-tenant isolation — enforced by RLS + the tenant-guarded report RPCs,
 *    tested with real role impersonation in src/__tests__/rls.test.ts
 *    ("report RPC guards": cross-tenant/NULL-role callers get zero rows,
 *    sub-client narrowing). The app-layer contract (every dashboard query
 *    carries client_id — public-SELECT tables don't tenant-scope themselves)
 *    is asserted in src/__tests__/reports/reports-page.test.tsx.
 * 2. VER-179 SLA scorecard regression guard + zero-data empty states +
 *    RPC-failure error cards — full-page composition render in
 *    reports-page.test.tsx (jsdom), which runs on EVERY PR, not only on
 *    base==main release PRs like this suite.
 * 3. The auth boundary itself — HERE, through the real proxy in a real
 *    browser: an unauthenticated visitor must never reach /admin/reports.
 */

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

test.describe('Admin reports — route boundary', () => {
  test('unauthenticated access to /admin/reports redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/reports')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('no report data reaches an unauthenticated browser', async ({ page }) => {
    await mockNoSession(page)
    // Belt-and-braces on the boundary: record any PostgREST traffic the
    // redirect journey fires. The reports queries (booking, service_ticket,
    // report RPCs) must never be issued to an unauthenticated visitor.
    const restCalls: string[] = []
    await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
      restCalls.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.goto('/admin/reports')
    await expect(page).toHaveURL(/\/auth/)
    const reportCalls = restCalls.filter(
      (u) => u.includes('/rpc/get_') || u.includes('booking') || u.includes('service_ticket'),
    )
    expect(reportCalls).toEqual([])
  })
})
