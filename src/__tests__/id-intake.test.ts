import { describe, it, expect } from 'vitest'
import { idIntakeSchema, buildIdNotes } from '@/lib/booking/id-intake'
import { photoCount } from '@/lib/booking/id-photos'

const VALID = {
  latitude: -32.27,
  longitude: 115.75,
  geo_address: '12 Test St, Safety Bay',
  collection_date_id: 'a4d9b8c2-1111-4000-8000-000000000001',
  collection_area_id: 'a4d9b8c2-2222-4000-8000-000000000002',
  waste_types: ['General / Mixed'],
  volume: 'Small (< 1 ute)',
  description: 'Pile of mixed waste',
  photo_urls: [],
  notes: '',
}

describe('idIntakeSchema', () => {
  it('accepts a valid submission', () => {
    expect(idIntakeSchema.safeParse(VALID).success).toBe(true)
  })

  it('accepts every canonical volume', () => {
    for (const volume of ['Small (< 1 ute)', 'Medium (1–3 utes)', 'Large (> 3 utes)']) {
      expect(idIntakeSchema.safeParse({ ...VALID, volume }).success).toBe(true)
    }
  })

  it('rejects out-of-range coordinates', () => {
    expect(idIntakeSchema.safeParse({ ...VALID, latitude: -91 }).success).toBe(false)
    expect(idIntakeSchema.safeParse({ ...VALID, longitude: 181 }).success).toBe(false)
  })

  it('rejects an unknown waste type', () => {
    expect(
      idIntakeSchema.safeParse({ ...VALID, waste_types: ['Radioactive'] }).success
    ).toBe(false)
  })

  it('rejects an empty waste type list', () => {
    expect(idIntakeSchema.safeParse({ ...VALID, waste_types: [] }).success).toBe(false)
  })

  it('rejects a free-text volume', () => {
    expect(idIntakeSchema.safeParse({ ...VALID, volume: 'Heaps' }).success).toBe(false)
  })

  it('rejects non-uuid ids', () => {
    expect(
      idIntakeSchema.safeParse({ ...VALID, collection_date_id: 'not-a-uuid' }).success
    ).toBe(false)
  })

  it('rejects non-https photo URLs', () => {
    expect(
      idIntakeSchema.safeParse({ ...VALID, photo_urls: ['http://evil.example/x.jpg'] })
        .success
    ).toBe(false)
  })
})

describe('buildIdNotes', () => {
  it('joins description and notes with a blank line', () => {
    expect(buildIdNotes('desc', 'notes')).toBe('desc\n\nnotes')
  })

  it('drops empty parts', () => {
    expect(buildIdNotes('desc', '')).toBe('desc')
    expect(buildIdNotes('', 'notes')).toBe('notes')
    expect(buildIdNotes('', '')).toBe('')
    expect(buildIdNotes('  ', '  ')).toBe('')
  })
})

describe('photoCount', () => {
  it('prefers the photos array when populated', () => {
    expect(photoCount(['a', 'b'], 'Photos: 5')).toBe(2)
  })

  it('falls back to the legacy notes count when the array is empty or null', () => {
    expect(photoCount([], 'Photos: 3')).toBe(3)
    expect(photoCount(null, 'Photos: 1')).toBe(1)
  })

  it('returns 0 with no photos and no notes', () => {
    expect(photoCount(null, null)).toBe(0)
    expect(photoCount(undefined, undefined)).toBe(0)
    expect(photoCount(null, 'no count here')).toBe(0)
  })

  it('handles Photos: 0 in notes', () => {
    expect(photoCount(null, 'Photos: 0')).toBe(0)
  })
})
