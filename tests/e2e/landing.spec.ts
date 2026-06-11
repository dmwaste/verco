import { test, expect } from '@playwright/test'

/**
 * Root landing surface (verco.au) — exercised via the dev root-host alias
 * `root.localhost` (RFC 6761 resolves *.localhost to loopback; precedent:
 * admin.localhost). Header forging is NOT a viable seam: the proxy strips
 * inbound x-verco-* headers on non-root branches, and the page's Supabase
 * query runs server-side where page.route() can't reach. Assertions against
 * DB-driven content are structural — CI runs against real Supabase data.
 */

const ROOT = 'http://root.localhost:3000'

test.describe('root landing page', () => {
  test('renders hero, picker, and staff link on the root host', async ({
    page,
  }) => {
    await page.goto(`${ROOT}/`)

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: /bulk verge collection, booked online in minutes/i,
      }),
    ).toBeVisible()

    // Hero image actually loaded (committed asset, not a 404'd path).
    const heroLoaded = await page
      .locator('img[src*="/landing/hero"]')
      .evaluate((el) => (el as HTMLImageElement).naturalWidth > 0)
    expect(heroLoaded).toBe(true)

    // Picker: structural — at least one tenant card with a Book action.
    await expect(
      page.getByRole('heading', { name: /find your council to get started/i }),
    ).toBeVisible()
    expect(
      await page.getByRole('link', { name: /book a collection/i }).count(),
    ).toBeGreaterThanOrEqual(1)

    // Staff sign-in targets the canonical admin host (dev flavour).
    await expect(
      page.getByRole('link', { name: /staff sign in/i }),
    ).toHaveAttribute('href', /admin\.localhost:3000\/admin/)

    // No recovery banner on a plain visit.
    await expect(
      page.getByText(/we couldn't open that booking link/i),
    ).toHaveCount(0)
  })

  test('failed /b/<ref> shows the recovery banner with a #book anchor', async ({
    page,
  }) => {
    // A guaranteed-unknown ref: resolve_booking_redirect returns no row, the
    // proxy falls through to the landing and sets the banner marker.
    await page.goto(`${ROOT}/b/BOGUS-REF-E2E-123`)

    const banner = page.getByText(/we couldn't open that booking link/i)
    await expect(banner).toBeVisible()
    await expect(
      page.getByRole('link', { name: /find your council below/i }),
    ).toHaveAttribute('href', '#book')
  })

  test('robots.txt passes through to the static file', async ({ request }) => {
    const res = await request.get(`${ROOT}/robots.txt`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('text/plain')
    expect(await res.text()).toContain('User-agent')
  })

  test('landing 404s on a tenant-resolved host (leak gate)', async ({
    request,
  }) => {
    // localhost resolves a tenant (dev bypass); the proxy strips any inbound
    // x-verco-root, so /landing must 404 — the root surface never leaks
    // onto tenant hosts.
    const res = await request.get('http://localhost:3000/landing', {
      headers: { 'x-verco-root': '1' },
    })
    expect(res.status()).toBe(404)
  })

  test('council picker peeks above the fold on mobile (390x844)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${ROOT}/`)

    const heading = page.getByRole('heading', {
      name: /find your council to get started/i,
    })
    const box = await heading.boundingBox()
    expect(box).not.toBeNull()
    // Design acceptance 1.1: the resident's next step is visible on arrival.
    expect(box!.y).toBeLessThan(844)
  })
})
