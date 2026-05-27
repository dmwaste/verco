/**
 * Unit tests for buildMudContext — the helper that fetches MUD-specific
 * context for the admin booking detail page and wraps checkMudAllowance.
 *
 * Core allowance math is already covered by mud-allowance.test.ts.
 * Here we cover the fetch-layer branches:
 *   - non-MUD property returns null (defensive guard)
 *   - zero active services returns an empty allowance summary
 *   - happy path passes correct inputs to checkMudAllowance
 */
import { describe, it, expect, vi } from 'vitest'
import { buildMudContext } from '@/app/(admin)/admin/bookings/[id]/mud-context'

type Row = Record<string, unknown>

/**
 * Minimal builder for a chainable Supabase query mock. Each `.from(table)`
 * call returns a chain with predetermined responses keyed by the LAST
 * resolving call (.single() for property; .in() for array-returning queries).
 */
function makeClient(responses: {
  property?: { data: Row | null; error?: unknown }
  rules?: { data: Row[] | null; error?: unknown }
  usage?: { data: Row[] | null; error?: unknown }
  overrides?: { data: Row[] | null; error?: unknown }
}) {
  // The function makes 4 sequential .from() calls in order:
  // 1. eligible_properties (.single() resolves)
  // 2. service_rules (.eq() resolves the array)
  // 3. booking_item (.in() resolves the array)
  // 4. allocation_override (.in() resolves the array)
  const fromCalls = [
    { last: 'single', response: responses.property ?? { data: null } },
    { last: 'eq', response: responses.rules ?? { data: [] } },
    { last: 'in', response: responses.usage ?? { data: [] } },
    { last: 'in', response: responses.overrides ?? { data: [] } },
  ]
  let callIndex = 0

  function makeChain() {
    const current = fromCalls[callIndex++]
    if (!current) throw new Error('Unexpected extra .from() call')
    const settle = vi.fn().mockResolvedValue(current.response)
    const chain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq: current.last === 'eq' ? settle : vi.fn().mockReturnThis(),
      in: current.last === 'in' ? settle : vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      single: current.last === 'single' ? settle : vi.fn().mockReturnThis(),
    }
    // For the eq-chain on service_rules, .select().eq() should resolve directly.
    // For the in-chain on booking_item / allocation_override, the path is
    // .select().eq().eq().not().in() — all intermediates return `chain`.
    return chain
  }

  return {
    from: vi.fn().mockImplementation(() => makeChain()),
  }
}

const inputs = {
  propertyId: 'prop-1',
  collectionAreaId: 'area-1',
  fyId: 'fy-1',
}

describe('buildMudContext', () => {
  it('returns null when the property is not a MUD', async () => {
    const client = makeClient({
      property: { data: { id: 'prop-1', is_mud: false, unit_count: 0 } },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildMudContext(client as any, inputs)
    expect(result).toBeNull()
  })

  it('returns null when the property is not found at all', async () => {
    const client = makeClient({ property: { data: null } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildMudContext(client as any, inputs)
    expect(result).toBeNull()
  })

  it('returns context with empty allowance when no active services exist', async () => {
    const client = makeClient({
      property: {
        data: {
          id: 'prop-1',
          is_mud: true,
          unit_count: 12,
          mud_code: 'KWN-MUD-001',
          mud_onboarding_status: 'Registered',
          strata_contact: null,
        },
      },
      rules: { data: [] }, // no service_rules for this area
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildMudContext(client as any, inputs)
    expect(result).not.toBeNull()
    expect(result?.unitCount).toBe(12)
    expect(result?.mudCode).toBe('KWN-MUD-001')
    expect(result?.allowance).toEqual([])
  })

  it('computes per-service allowance with used + overrides', async () => {
    const client = makeClient({
      property: {
        data: {
          id: 'prop-1',
          is_mud: true,
          unit_count: 10,
          mud_code: 'COT-MUD-005',
          mud_onboarding_status: 'Registered',
          strata_contact: {
            first_name: 'Test',
            last_name: 'Strata',
            full_name: 'Test Strata',
            email: 'test@example.com',
            mobile_e164: '+61400000000',
          },
        },
      },
      rules: {
        data: [
          {
            service_id: 'svc-bulk',
            max_collections: 2,
            service: { id: 'svc-bulk', name: 'General Bulk', is_active: true },
          },
          {
            service_id: 'svc-green',
            max_collections: 1,
            service: { id: 'svc-green', name: 'Green Waste', is_active: true },
          },
        ],
      },
      usage: {
        data: [
          { service_id: 'svc-bulk', no_services: 5 },
          { service_id: 'svc-bulk', no_services: 3 }, // aggregates to 8
          { service_id: 'svc-green', no_services: 4 },
        ],
      },
      overrides: {
        data: [{ service_id: 'svc-bulk', extra_allocations: 3 }],
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildMudContext(client as any, inputs)
    expect(result).not.toBeNull()

    const bulk = result?.allowance.find((a) => a.service_id === 'svc-bulk')
    // base_cap = 10 * 2 = 20; +3 override = 23 total; used 8
    expect(bulk?.base_cap).toBe(20)
    expect(bulk?.override_extras).toBe(3)
    expect(bulk?.total_cap).toBe(23)
    expect(bulk?.used).toBe(8)
    expect(bulk?.ok).toBe(true)

    const green = result?.allowance.find((a) => a.service_id === 'svc-green')
    // base_cap = 10 * 1 = 10; no override; used 4
    expect(green?.total_cap).toBe(10)
    expect(green?.used).toBe(4)

    expect(result?.strataContact?.fullName).toBe('Test Strata')
  })

  it('skips inactive services from the allowance summary', async () => {
    const client = makeClient({
      property: {
        data: {
          id: 'prop-1',
          is_mud: true,
          unit_count: 5,
          mud_code: null,
          mud_onboarding_status: 'Registered',
          strata_contact: null,
        },
      },
      rules: {
        data: [
          {
            service_id: 'svc-active',
            max_collections: 1,
            service: { id: 'svc-active', name: 'Active', is_active: true },
          },
          {
            service_id: 'svc-inactive',
            max_collections: 1,
            service: { id: 'svc-inactive', name: 'Inactive', is_active: false },
          },
        ],
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await buildMudContext(client as any, inputs)
    expect(result?.allowance).toHaveLength(1)
    expect(result?.allowance[0]?.service_id).toBe('svc-active')
  })
})
