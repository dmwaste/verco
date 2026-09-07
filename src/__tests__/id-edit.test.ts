import { describe, it, expect } from 'vitest'
import {
  addressMateriallyChanged,
  dedupePhotos,
  parseIdEdit,
  photosArePreserved,
  wasteTypesEqual,
  type IdEditSubmission,
} from '@/lib/booking/id-edit'
import { ID_WASTE_TYPES } from '@/lib/booking/id-options'

// isAllowedPhotoUrl reads this at call time — pin it so the bucket allowlist
// is actually exercised (without it, test mode allows any https URL).
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'

const BUCKET_URL = 'https://test.supabase.co/storage/v1/object/public/ncn-photos'

function payload(overrides: Partial<IdEditSubmission> = {}): IdEditSubmission {
  return {
    geo_address: '1 Linwood Court, Osborne Park WA, Australia',
    latitude: -31.9092618,
    longitude: 115.8207249,
    waste_types: ['Whitegoods'],
    volume: '2 allocations (6m³)',
    photo_urls: [`${BUCKET_URL}/id-bookings/a.jpg`],
    expected_updated_at: '2026-08-28 02:24:41.087144+00',
    ...overrides,
  }
}

describe('parseIdEdit', () => {
  it('accepts a valid payload', () => {
    const r = parseIdEdit(payload(), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(true)
  })

  it('accepts a pinless payload — booking lat/lng are nullable (E4)', () => {
    const r = parseIdEdit(payload({ latitude: null, longitude: null }), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(true)
  })

  it('rejects a half-null pin pair', () => {
    const r = parseIdEdit(payload({ latitude: null }), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(false)
  })

  it('rejects a blank address (edit tightens the intake schema)', () => {
    const r = parseIdEdit(payload({ geo_address: '   ' }), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(false)
  })

  it('rejects an unknown NEW waste type', () => {
    const r = parseIdEdit(payload({ waste_types: ['Asbestos'] }), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Asbestos')
  })

  it('accepts a legacy tag already stored on the row (service-name-rename class)', () => {
    const r = parseIdEdit(
      payload({ waste_types: ['Old Renamed Tag', 'Mattress'] }),
      ['Old Renamed Tag'],
      ID_WASTE_TYPES,
    )
    expect(r.ok).toBe(true)
  })

  it('rejects empty waste types', () => {
    const r = parseIdEdit(payload({ waste_types: [] }), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(false)
  })

  it('rejects an invalid volume', () => {
    const r = parseIdEdit(payload({ volume: 'heaps' }), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(false)
  })

  it('rejects a photo URL outside the storage bucket (img-src allowlist)', () => {
    const r = parseIdEdit(
      payload({ photo_urls: ['https://evil.example.com/x.jpg'] }),
      [],
      ID_WASTE_TYPES,
    )
    expect(r.ok).toBe(false)
  })

  it('rejects a missing concurrency token', () => {
    const r = parseIdEdit(payload({ expected_updated_at: '' }), [], ID_WASTE_TYPES)
    expect(r.ok).toBe(false)
  })
})

describe('photosArePreserved (append-only, set semantics — same as trigger @>)', () => {
  const a = `${BUCKET_URL}/id-bookings/a.jpg`
  const b = `${BUCKET_URL}/id-bookings/b.jpg`

  it('adding is allowed', () => {
    expect(photosArePreserved([a], [a, b])).toBe(true)
  })

  it('removing is rejected', () => {
    expect(photosArePreserved([a, b], [a])).toBe(false)
  })

  it('identical sets pass', () => {
    expect(photosArePreserved([a], [a])).toBe(true)
  })

  it('duplicate collapse still preserves the set (multiplicity edge, E-finding 9)', () => {
    // Stored [a, a] deduped to [a]: set semantics say preserved — matching
    // Postgres @> which ignores multiplicity. Both layers agree by design.
    expect(photosArePreserved(dedupePhotos([a, a]), [a])).toBe(true)
  })

  it('empty stored array always passes', () => {
    expect(photosArePreserved([], [b])).toBe(true)
  })
})

describe('wasteTypesEqual (order-insensitive no-op detection)', () => {
  it('order does not register as change', () => {
    expect(wasteTypesEqual(['A', 'B'], ['B', 'A'])).toBe(true)
  })
  it('detects real differences', () => {
    expect(wasteTypesEqual(['A'], ['A', 'B'])).toBe(false)
    expect(wasteTypesEqual(['A', 'B'], ['A', 'C'])).toBe(false)
  })
})

describe('addressMateriallyChanged (pin-stale confirm must never cry wolf)', () => {
  it('trim/whitespace/case cleanups are NOT material', () => {
    expect(addressMateriallyChanged('1 Linwood Court', ' 1  linwood   COURT ')).toBe(false)
  })
  it('a real change is material', () => {
    expect(
      addressMateriallyChanged('Front gate (Vincent works depot)', '1 Linwood Court, Osborne Park'),
    ).toBe(true)
  })
  it('null before compares as empty', () => {
    expect(addressMateriallyChanged(null, 'anything')).toBe(true)
    expect(addressMateriallyChanged(null, '  ')).toBe(false)
  })
})
