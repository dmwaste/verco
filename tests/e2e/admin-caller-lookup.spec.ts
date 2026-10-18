import { test, expect } from '@playwright/test'

/**
 * Caller lookup (VER-316) — the login round-trip through the REAL proxy.
 *
 * Teams opens https://admin.verco.au/admin/lookup?phone={phone} when Kim
 * answers. If her session has expired, the proxy sends her to /auth, and the
 * caller's number must survive sign-in. Exercised on the dev admin host alias
 * `admin.localhost` (RFC 6761 loopback; the proxy's admin-host branch is the
 * one that redirects). A real OTP sign-in can't run in CI (OTP-only auth, anon
 * key), so the hand-off from /auth/verify is asserted through its "Change
 * email" link, which carries the same validated `next`. The lookup's data path
 * is covered by caller-matches.test.ts and caller-lookup-view.test.tsx.
 */

const ADMIN = 'http://admin.localhost:3000'
const LOOKUP = '/admin/lookup?phone=+61412345678'

test.describe('Caller lookup — logged-out round-trip', () => {
  test('an unauthenticated call pop lands on /auth carrying the lookup as next', async ({ page }) => {
    // Teams sends the + unencoded — exactly what the browser requests here.
    await page.goto(`${ADMIN}${LOOKUP}`)

    await expect(page).toHaveURL(/\/auth\?next=/)
    expect(new URL(page.url()).searchParams.get('next')).toBe(LOOKUP)
  })

  test('the verify step keeps next when going back to change email', async ({ page }) => {
    const params = new URLSearchParams({ email: 'kim@example.com', next: LOOKUP })
    await page.goto(`${ADMIN}/auth/verify?${params}`)

    await page.getByRole('button', { name: /change email/i }).click()

    await expect(page).toHaveURL(/\/auth\?next=/)
    expect(new URL(page.url()).searchParams.get('next')).toBe(LOOKUP)
  })

  test('an off-site next is dropped', async ({ page }) => {
    const params = new URLSearchParams({ email: 'kim@example.com', next: 'https://evil.example' })
    await page.goto(`${ADMIN}/auth/verify?${params}`)

    await page.getByRole('button', { name: /change email/i }).click()

    await expect(page).toHaveURL(`${ADMIN}/auth`)
  })
})
