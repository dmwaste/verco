import { describe, it, expect } from 'vitest'
import { checkMudAllowance } from '@/lib/mud/allowance'

const baseService = {
  service_id: 'svc-bulk',
  service_name: 'General Bulk',
  max_collections_per_unit: 1,
  used: 0,
  override_extras: 0,
  requested: 0,
}

describe('checkMudAllowance', () => {
  it('base cap = unit_count × max_collections_per_unit', () => {
    const result = checkMudAllowance({
      unit_count: 12,
      services: [{ ...baseService, requested: 12 }],
    })
    expect(result.ok).toBe(true)
    expect(result.per_service[0]?.base_cap).toBe(12)
    expect(result.per_service[0]?.total_cap).toBe(12)
  })

  it('no overrides → cap = base', () => {
    const result = checkMudAllowance({
      unit_count: 10,
      services: [{ ...baseService, max_collections_per_unit: 2, requested: 0 }],
    })
    expect(result.per_service[0]?.total_cap).toBe(20)
  })

  it('one override adds to cap', () => {
    const result = checkMudAllowance({
      unit_count: 10,
      services: [{ ...baseService, override_extras: 4, requested: 14 }],
    })
    expect(result.ok).toBe(true)
    expect(result.per_service[0]?.total_cap).toBe(14)
  })

  it('used + requested at exact cap → ok (boundary)', () => {
    const result = checkMudAllowance({
      unit_count: 12,
      services: [{ ...baseService, used: 6, requested: 6 }],
    })
    expect(result.ok).toBe(true)
    expect(result.per_service[0]?.remaining_after).toBe(0)
  })

  it('used + requested > cap → reject with breakdown', () => {
    const result = checkMudAllowance({
      unit_count: 12,
      services: [{ ...baseService, used: 10, requested: 4 }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('14/12')
    expect(result.per_service[0]?.remaining_after).toBe(-2)
  })

  it('multiple services — one over cap blocks the whole booking', () => {
    const result = checkMudAllowance({
      unit_count: 12,
      services: [
        { ...baseService, service_id: 'svc-a', service_name: 'Bulk', requested: 6 },
        { ...baseService, service_id: 'svc-b', service_name: 'Green', used: 12, requested: 1 },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.per_service[0]?.ok).toBe(true)
    expect(result.per_service[1]?.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
  })

  it('unit_count = 0 → error (not yet recorded)', () => {
    const result = checkMudAllowance({
      unit_count: 0,
      services: [{ ...baseService, requested: 1 }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('Unit count must be recorded')
  })

  it('per-service results preserved in order', () => {
    const result = checkMudAllowance({
      unit_count: 10,
      services: [
        { ...baseService, service_id: 'a', service_name: 'A', requested: 1 },
        { ...baseService, service_id: 'b', service_name: 'B', requested: 1 },
        { ...baseService, service_id: 'c', service_name: 'C', requested: 1 },
      ],
    })
    expect(result.per_service.map((s) => s.service_id)).toEqual(['a', 'b', 'c'])
  })

  it('override only applies to its own service', () => {
    const result = checkMudAllowance({
      unit_count: 10,
      services: [
        { ...baseService, service_id: 'a', service_name: 'A', override_extras: 5, requested: 0 },
        { ...baseService, service_id: 'b', service_name: 'B', override_extras: 0, requested: 0 },
      ],
    })
    expect(result.per_service[0]?.total_cap).toBe(15)
    expect(result.per_service[1]?.total_cap).toBe(10)
  })
})
