import { describe, expect, it } from 'vitest'
import { areaOptionLabel } from '@/app/(admin)/admin/properties/area-option-label'

describe('areaOptionLabel', () => {
  it('renders code and name for a live area', () => {
    expect(areaOptionLabel({ code: 'VIN', name: 'Vincent', is_active: true })).toBe('VIN — Vincent')
  })

  it('flags a staged-off area as not yet live', () => {
    expect(areaOptionLabel({ code: 'SUB', name: 'Subiaco', is_active: false })).toBe(
      'SUB — Subiaco (not yet live)',
    )
  })
})
