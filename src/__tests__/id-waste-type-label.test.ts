import { describe, it, expect } from 'vitest'
import { ID_WASTE_TYPES, idWasteTypeLabel } from '@/lib/booking/id-options'

describe('idWasteTypeLabel (#461)', () => {
  it('renames General / Mixed to Bulk Waste at the display edge', () => {
    expect(idWasteTypeLabel('General / Mixed')).toBe('Bulk Waste')
  })

  it('passes every other stored value through unchanged', () => {
    for (const value of ID_WASTE_TYPES) {
      if (value === 'General / Mixed') continue
      expect(idWasteTypeLabel(value)).toBe(value)
    }
  })

  it('leaves unknown historical values as-is (never blanks crew-facing data)', () => {
    expect(idWasteTypeLabel('Some Legacy Value')).toBe('Some Legacy Value')
  })

  it('keeps the STORED value stable — the rename is display-only by design', () => {
    // If this fails, someone changed the stored identifier: historical
    // booking.id_waste_types rows and OR-pushed notes still carry the old
    // string, so reports and closeouts would split across two values.
    expect(ID_WASTE_TYPES).toContain('General / Mixed')
    expect(ID_WASTE_TYPES).not.toContain('Bulk Waste')
  })
})
