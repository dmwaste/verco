import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * #625 drift guard. A reinstatement's category bonus is the sum of every override
 * in that category, so both pricing paths must know EVERY service's category —
 * a `.in('id', …)` on the service lookup brings back the cart-only map that
 * charged residents for collections the council reinstated free. The Deno EF
 * can't be imported into Vitest, so this checks the source of each lookup.
 */
const PRICING_PATHS = ['supabase/functions/_shared/pricing.ts', 'src/app/(public)/book/confirm/confirm-form.tsx']

/** The service query: from `.from('service')` to the next query or the end of its Promise.all slot. */
function serviceLookup(src: string): string {
  const start = src.indexOf(".from('service')")
  if (start === -1) throw new Error("no .from('service') lookup found")
  const rest = src.slice(start + 1)
  const end = rest.search(/\.from\(|usagePromise|\]\)/)
  return rest.slice(0, end === -1 ? undefined : end)
}

describe.each(PRICING_PATHS)('%s', (file) => {
  it('looks up every service category, not just the cart (#625)', () => {
    expect(serviceLookup(readFileSync(file, 'utf8'))).not.toMatch(/\.in\(/)
  })
})
