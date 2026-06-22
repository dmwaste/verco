import { describe, it, expect } from 'vitest'
import {
  normaliseAuMobile,
  formatAuMobileDisplay,
  BookingItemSchema,
  ContactSchema,
  LOCATION_OPTIONS,
  STAFF_LOCATION_OPTION,
} from '@/lib/booking/schemas'

describe('normaliseAuMobile', () => {
  it('converts local format 04XXXXXXXX to E.164', () => {
    expect(normaliseAuMobile('0412345678')).toBe('+61412345678')
  })

  it('passes through E.164 format +614XXXXXXXX', () => {
    expect(normaliseAuMobile('+61412345678')).toBe('+61412345678')
  })

  it('prepends + to 614XXXXXXXX', () => {
    expect(normaliseAuMobile('61412345678')).toBe('+61412345678')
  })

  it('strips whitespace', () => {
    expect(normaliseAuMobile('04 12 345 678')).toBe('+61412345678')
  })

  it('strips dashes', () => {
    expect(normaliseAuMobile('0412-345-678')).toBe('+61412345678')
  })

  it('strips parentheses', () => {
    expect(normaliseAuMobile('(04) 12345678')).toBe('+61412345678')
  })

  it('returns null for landline', () => {
    expect(normaliseAuMobile('0312345678')).toBeNull()
  })

  it('returns null for too short', () => {
    expect(normaliseAuMobile('041234567')).toBeNull()
  })

  it('returns null for too long', () => {
    expect(normaliseAuMobile('04123456789')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(normaliseAuMobile('')).toBeNull()
  })

  it('returns null for alpha input', () => {
    expect(normaliseAuMobile('abcdefghij')).toBeNull()
  })
})

describe('formatAuMobileDisplay', () => {
  it('formats E.164 to display format', () => {
    expect(formatAuMobileDisplay('+61412345678')).toBe('0412 345 678')
  })

  it('returns input unchanged if invalid length', () => {
    expect(formatAuMobileDisplay('+6141234')).toBe('+6141234')
  })
})

describe('BookingItemSchema', () => {
  const validItem = {
    service_id: '550e8400-e29b-41d4-a716-446655440000',
    service_name: 'General Waste',
    category_name: 'Bulk',
    code: 'bulk' as const,
    no_services: 2,
    free_units: 1,
    paid_units: 1,
    unit_price_cents: 5000,
    line_charge_cents: 5000,
  }

  it('accepts valid input', () => {
    const result = BookingItemSchema.safeParse(validItem)
    expect(result.success).toBe(true)
  })

  it('rejects non-UUID service_id', () => {
    const result = BookingItemSchema.safeParse({ ...validItem, service_id: 'not-a-uuid' })
    expect(result.success).toBe(false)
  })

  it('rejects negative no_services', () => {
    const result = BookingItemSchema.safeParse({ ...validItem, no_services: -1 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer no_services', () => {
    const result = BookingItemSchema.safeParse({ ...validItem, no_services: 1.5 })
    expect(result.success).toBe(false)
  })
})

describe('ContactSchema', () => {
  const validContact = {
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@example.com',
    mobile: '0412345678',
  }

  it('transforms valid mobile to E.164', () => {
    const result = ContactSchema.safeParse(validContact)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mobile).toBe('+61412345678')
    }
  })

  it('rejects empty first_name', () => {
    const result = ContactSchema.safeParse({ ...validContact, first_name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects empty last_name', () => {
    const result = ContactSchema.safeParse({ ...validContact, last_name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing last_name (single-name input)', () => {
    const result = ContactSchema.safeParse({
      first_name: 'Madonna',
      email: 'm@example.com',
      mobile: '0412345678',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid email', () => {
    const result = ContactSchema.safeParse({ ...validContact, email: 'notanemail' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid mobile', () => {
    const result = ContactSchema.safeParse({ ...validContact, mobile: '0312345678' })
    expect(result.success).toBe(false)
  })
})

describe('LOCATION_OPTIONS', () => {
  it('contains exactly the expected resident options', () => {
    expect(LOCATION_OPTIONS).toEqual(['Front Verge', 'Side Verge', 'Driveway'])
  })
  it('keeps Other as a staff-only option, out of the resident list', () => {
    expect(LOCATION_OPTIONS).not.toContain('Other')
    expect(STAFF_LOCATION_OPTION).toBe('Other')
  })
})
