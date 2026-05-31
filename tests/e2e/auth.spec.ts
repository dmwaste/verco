import { test, expect, type Page, type Route } from '@playwright/test'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321'

/** Mock Supabase auth to return no session (unauthenticated) */
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

test.describe('Auth', () => {
  test('auth page renders email form', async ({ page }) => {
    await page.goto('/auth')

    // Form elements are visible
    const emailInput = page.getByPlaceholder('you@example.com')
    await expect(emailInput).toBeVisible()
    await expect(page.getByRole('button', { name: /Send Code/ })).toBeVisible()

    // Can type email
    await emailInput.fill('test@example.com')
    await expect(emailInput).toHaveValue('test@example.com')
  })

  test('verify page renders OTP input cells', async ({ page }) => {
    // Navigate directly to verify page with email param
    await page.goto('/auth/verify?email=test%40example.com')

    // Should show the check email heading
    await expect(page.getByText('Check your email')).toBeVisible()

    // Should show the email address
    await expect(page.getByText('test@example.com')).toBeVisible()

    // Should have 6 OTP input cells
    const otpCells = page.locator('input[inputmode="numeric"]')
    await expect(otpCells).toHaveCount(6)
  })

  test('unauthenticated access to /admin redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('unauthenticated access to /field/run-sheet redirects to /auth', async ({ page }) => {
    await mockNoSession(page)
    await page.goto('/field/run-sheet')
    await expect(page).toHaveURL(/\/auth/)
  })

  test('public /book page is accessible without auth', async ({ page }) => {
    await mockNoSession(page)

    // Mock REST calls the address form makes
    await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.goto('/book')
    await expect(page).toHaveURL(/\/book/)
    await expect(page.getByRole('heading', { name: 'Book a Collection' })).toBeVisible()
  })

  // Sign-out is gated on auth state: the resident nav must NOT show a sign-out
  // control to an unauthenticated visitor (it renders for anon /book visitors).
  // The authed sign-out flow itself runs through a server action (server-side
  // signOut), which the mock harness can't exercise — that path is verified via
  // /qa against the live deploy.
  test('unauthenticated public page does not show a Sign out control', async ({ page }) => {
    await mockNoSession(page)
    await page.route(`${supabaseUrl}/rest/v1/**`, async (route: Route) => {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.goto('/book')
    await expect(page).toHaveURL(/\/book/)
    await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  })
})
