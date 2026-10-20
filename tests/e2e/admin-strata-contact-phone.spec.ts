import { test, expect, type Page, type Route } from '@playwright/test'
import { PHONE_INVALID_MESSAGE } from '../../src/lib/phone'

/**
 * Wrong-length Australian phone rejected on the strata contact form (#668 /
 * #684). The resident-facing half of #684 (the booking confirm step) runs for
 * real in CI in booking-flow.spec.ts — "Contact phone validation (#668)".
 *
 * WHERE EACH GUARANTEE IS TESTED — read before extending this file.
 * /admin/properties sits behind the (admin) layout's server-side auth guard,
 * which page.route() cannot mock, and CI's E2E job carries only the anon key
 * against an OTP-only auth config — so the logged-in walk cannot execute
 * there. Coverage lands where each guarantee is enforced:
 *
 * 1. The rule itself (10-digit mobiles, landlines with the area code, 1300 /
 *    13xx / international) — isValidPhone in src/__tests__/schemas.test.ts and
 *    src/__tests__/mud-validation.test.ts (every PR).
 * 2. The server write path — upsertStrataContact rejects a CHANGED invalid
 *    number with the same message and leaves an unchanged old number alone,
 *    src/__tests__/update-contact-phone.test.ts.
 * 3. The auth boundary — HERE, through the real proxy + layout guard in a real
 *    browser: the properties page is not reachable anonymously and no property
 *    rows are issued to that visitor from it.
 * 4. The logged-in walk — HERE, seeded-or-skip (like admin-property-notes
 *    .spec.ts): against a seeded dev/preview with a staff session, the
 *    properties list is fed ONE fixture row (so no real property is touched),
 *    the Set-as-MUD form is opened from its row menu, and a 9-digit mobile on
 *    the strata contact must be refused in the form — before the server action
 *    is ever called.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'

const FIXTURE_AREA = {
  id: '00000000-0000-4000-8000-000000684002',
  name: 'Fixture Area 1',
  code: 'FIX-1',
  client_id: '00000000-0000-4000-8000-000000684003',
}

/** A residential row — nothing on it is real. */
const FIXTURE_PROPERTY = {
  id: '00000000-0000-4000-8000-000000684001',
  address: '7 FIXTURE WAY FIXTUREVILLE',
  formatted_address: '7 Fixture Way, Fixtureville WA 6000',
  collection_area_id: FIXTURE_AREA.id,
  is_mud: false,
  is_eligible: true,
  mud_code: null,
  mud_onboarding_status: null,
  unit_count: 1,
  has_geocode: true,
  latitude: -32.0,
  longitude: 115.8,
  collection_area: { name: FIXTURE_AREA.name, code: FIXTURE_AREA.code, client_id: FIXTURE_AREA.client_id },
}

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

/**
 * Feed the properties list its fixture row. The page's reads are client-side
 * (TanStack Query over PostgREST) so they ARE mockable; everything else passes
 * through to the real session.
 */
async function setupPropertiesMocks(page: Page) {
  await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
    const url = route.request().url()
    const method = route.request().method()

    if (url.includes('/eligible_properties')) {
      if (method === 'HEAD') {
        // The un-geocoded counter (count-only query).
        return route.fulfill({ status: 200, headers: { 'Content-Range': '*/0' }, body: '' })
      }
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Content-Range': '0-0/1' },
          body: JSON.stringify([FIXTURE_PROPERTY]),
        })
      }
    }
    if (url.includes('/collection_area') && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FIXTURE_AREA]) })
    }
    return route.continue()
  })
}

/** Open the properties list; return false (and skip) when there is no staff session. */
async function gotoPropertiesOrSkip(page: Page): Promise<boolean> {
  await page.goto('/admin/properties')
  await page.waitForLoadState('networkidle')
  if (new URL(page.url()).pathname !== '/admin/properties') {
    test.skip(true, 'No staff session — skipping (runs against seeded/preview data with a staff login)')
    return false
  }
  return true
}

test.describe('Strata contact phone — route boundary', () => {
  test('unauthenticated access to /admin/properties redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin/properties')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('no property rows reach an unauthenticated browser from the admin list', async ({ page }) => {
    await mockNoSession(page)
    const restCalls: string[] = []
    await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
      restCalls.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.goto('/admin/properties')
    await expect(page).toHaveURL(/\/auth/)
    expect(restCalls.filter((u) => u.includes('eligible_properties'))).toEqual([])
  })
})

test.describe('Strata contact phone — Set-as-MUD form (seeded)', () => {
  test('a 9-digit mobile on the strata contact is refused in the form with the exact message', async ({ page }) => {
    await setupPropertiesMocks(page)
    if (!(await gotoPropertiesOrSkip(page))) return

    const row = page.getByRole('row', { name: /7 Fixture Way/ })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Property actions' }).click()
    await page.getByRole('menuitem', { name: 'Set MUD' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Set as MUD')).toBeVisible()
    await dialog.getByLabel(/MUD code/).fill('FIX-1-MUD-E2E')
    await dialog.getByLabel('Strata contact first name').fill('Sam')
    await dialog.getByLabel('Strata contact last name').fill('Fixture')
    await dialog.getByLabel('Strata contact phone').fill('041234567')
    await dialog.getByLabel('Strata contact email').fill('strata@example.com')

    const save = dialog.getByRole('button', { name: 'Save MUD' })
    await save.click()

    await expect(dialog.getByText(`Strata contact phone: ${PHONE_INVALID_MESSAGE}`)).toBeVisible()
    // Refused client-side: the form stays open and the button never entered its
    // "Saving..." state, so upsertStrataContact was not reached.
    await expect(dialog).toBeVisible()
    await expect(save).toBeEnabled()
    await expect(save).toHaveText('Save MUD')
  })
})
