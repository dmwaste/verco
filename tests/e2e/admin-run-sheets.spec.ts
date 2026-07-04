import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Admin run sheets — E2E route boundary.
 *
 * WHERE EACH GUARANTEE IS TESTED — read before extending this file.
 * The proxy's auth gate and the pages' contractor-only guard run SERVER-SIDE
 * (`supabase.auth.getUser()` in src/proxy.ts, `current_user_role()` in the
 * page), which Playwright route-interception cannot mock, and CI's E2E job
 * carries only the anon key against an OTP-only auth config — so a genuine
 * logged-in walk cannot execute here. Coverage lands where each guarantee is
 * enforced:
 *
 * 1. Contractor-only access (client-admin must NOT reach the operator surface)
 *    — the guard predicate is unit-tested in src/__tests__/roles.test.ts
 *    (isContractorStaff), and the pages redirect('/admin') on a non-contractor
 *    role. collection_stop RLS role coverage lives in src/__tests__/rls.test.ts.
 * 2. Run aggregation + status + fetch contract — pure-logic tests in
 *    stop-runs.test.ts (groupStopsIntoRuns, runStatus) and the query contract
 *    in run-sheet-data.test.ts (both run on EVERY PR).
 * 3. The auth boundary itself — HERE, through the real proxy in a real browser:
 *    an unauthenticated visitor must never reach the run sheets, and no
 *    collection_stop data may be issued to them.
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

test.describe('Admin run sheets — route boundary', () => {
  test('unauthenticated access to /admin/run-sheets redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/run-sheets')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('unauthenticated access to a run detail redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/run-sheets/2026-07-08/KWN1')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('unauthenticated access to the unassigned bucket redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/run-sheets/2026-07-08/unassigned')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('no collection_stop data reaches an unauthenticated browser', async ({ page }) => {
    await mockNoSession(page)
    const restCalls: string[] = []
    await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
      restCalls.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.goto('/admin/run-sheets')
    await expect(page).toHaveURL(/\/auth/)
    const stopCalls = restCalls.filter(
      (u) => u.includes('collection_stop') || u.includes('collection_run_meta'),
    )
    expect(stopCalls).toEqual([])
  })
})
