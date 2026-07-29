import { describe, it, expect } from 'vitest'
import { resolveServiceDescription } from '@/lib/client/service-descriptions'

describe('resolveServiceDescription (#454)', () => {
  it('returns the tenant override for a matching service name', () => {
    const overrides = { 'Bulk Waste': 'Broken furniture, household appliances, junk items' }
    expect(resolveServiceDescription(overrides, 'Bulk Waste')).toBe(
      'Broken furniture, household appliances, junk items'
    )
  })

  it('returns null for a service with no override (falls back to app copy)', () => {
    const overrides = { 'Bulk Waste': 'Custom copy' }
    expect(resolveServiceDescription(overrides, 'Green Waste')).toBeNull()
  })

  it('returns null for empty/null/malformed jsonb (admin-authored, not schema-enforced)', () => {
    expect(resolveServiceDescription({}, 'Bulk Waste')).toBeNull()
    expect(resolveServiceDescription(null, 'Bulk Waste')).toBeNull()
    expect(resolveServiceDescription(undefined, 'Bulk Waste')).toBeNull()
    expect(resolveServiceDescription('not-an-object', 'Bulk Waste')).toBeNull()
    expect(resolveServiceDescription(['array'], 'Bulk Waste')).toBeNull()
    expect(resolveServiceDescription({ 'Bulk Waste': 42 }, 'Bulk Waste')).toBeNull()
    expect(resolveServiceDescription({ 'Bulk Waste': '' }, 'Bulk Waste')).toBeNull()
  })
})
