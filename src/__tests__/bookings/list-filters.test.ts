import { describe, expect, it } from 'vitest'
import {
  areaFilterGroups,
  onlyKnown,
  onlyUuids,
  parseMultiParam,
} from '@/app/(admin)/admin/bookings/list-filters'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'

describe('parseMultiParam', () => {
  it('treats a missing or empty param as no filter', () => {
    expect(parseMultiParam(null)).toEqual([])
    expect(parseMultiParam('')).toEqual([])
  })

  it('reads an old single-value link as the one-item case', () => {
    expect(parseMultiParam('Scheduled')).toEqual(['Scheduled'])
  })

  it('splits comma-joined values, dropping blanks and repeats', () => {
    expect(parseMultiParam('Completed,,Nothing Presented,Completed')).toEqual([
      'Completed',
      'Nothing Presented',
    ])
  })
})

describe('onlyKnown / onlyUuids', () => {
  it('drops values the enum does not have, so PostgREST never 400s the list', () => {
    expect(onlyKnown(['Completed', 'Bogus', 'Rebooked'], ['Completed', 'Rebooked'] as const)).toEqual([
      'Completed',
      'Rebooked',
    ])
  })

  it('drops ids that are not uuids', () => {
    expect(onlyUuids([A, 'KWN-1', '1; drop table'])).toEqual([A])
  })
})

describe('areaFilterGroups', () => {
  it('groups areas by council, councils A→Z, areas by code', () => {
    const groups = areaFilterGroups([
      { id: B, code: 'CAM-B', sub_client: { name: 'Town of Cambridge' } },
      { id: C, code: 'COT', sub_client: { name: 'Town of Cottesloe' } },
      { id: A, code: 'CAM-A', sub_client: { name: 'Town of Cambridge' } },
    ])
    expect(groups).toEqual([
      { label: 'Town of Cambridge', options: [{ value: A, label: 'CAM-A' }, { value: B, label: 'CAM-B' }] },
      { label: 'Town of Cottesloe', options: [{ value: C, label: 'COT' }] },
    ])
  })

  it('puts areas with no council in a trailing group rather than losing them', () => {
    const groups = areaFilterGroups([
      { id: A, code: 'CAM-A', sub_client: { name: 'Town of Cambridge' } },
      { id: C, code: 'COT', sub_client: { name: 'Town of Cottesloe' } },
      { id: D, code: 'ZZZ', sub_client: null },
    ])
    expect(groups?.at(-1)).toEqual({ label: 'Other areas', options: [{ value: D, label: 'ZZZ' }] })
  })

  it('returns null (flat list) for a tenant with fewer than two councils', () => {
    expect(
      areaFilterGroups([
        { id: A, code: 'KWN-1', sub_client: null },
        { id: B, code: 'KWN-2', sub_client: null },
      ]),
    ).toBeNull()
    expect(
      areaFilterGroups([
        { id: A, code: 'CAM-A', sub_client: { name: 'Town of Cambridge' } },
        { id: B, code: 'CAM-B', sub_client: { name: 'Town of Cambridge' } },
      ]),
    ).toBeNull()
  })
})
