// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ExcelJS from 'exceljs'

/**
 * The Excel statement route shares the PDF route's gates (loadClientMonthlyReport):
 * contractor-admin only + accessible_client_ids() tenant check (§21). Both
 * must fail closed — supabase.from() throws unless a test opts in, so a
 * bypassed gate fails loudly instead of silently serving a workbook.
 */

const { rpc, from } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn<(table: string) => unknown>(() => {
    throw new Error('UNEXPECTED: gate bypassed, reached supabase.from()')
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ rpc, from })),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/(admin)/admin/reports/client-report/xlsx/route'

const CLIENT_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_CLIENT_ID = '00000000-0000-4000-8000-000000000000'

function makeRequest(clientId: string, month: string) {
  return new NextRequest(
    `https://admin.verco.au/admin/reports/client-report/xlsx?client=${clientId}&month=${month}`
  )
}

function gateRpc(role: string | null, accessible: string[] | null) {
  rpc.mockImplementation((fn: string) => {
    if (fn === 'current_user_role') return Promise.resolve({ data: role })
    if (fn === 'accessible_client_ids') return Promise.resolve({ data: accessible })
    throw new Error(`UNEXPECTED rpc call: ${fn}`)
  })
}

/** Minimal PostgREST builder stand-in: chainable, awaitable, `.single()`-able. */
interface Chain extends PromiseLike<unknown> {
  select: () => Chain
  eq: () => Chain
  limit: () => Chain
  single: () => Promise<unknown>
}
function query(result: { data: unknown; error: null }): Chain {
  const p = Promise.resolve(result)
  const chain: Chain = {
    select: () => chain,
    eq: () => chain,
    limit: () => chain,
    single: () => p,
    then: (onFulfilled, onRejected) => p.then(onFulfilled, onRejected),
  }
  return chain
}

const DENIED_ROLES = [
  'client-admin',
  'client-staff',
  'contractor-staff',
  'field',
  'ranger',
  'resident',
  null,
] as const

describe('client monthly report Excel route — authz gates', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(DENIED_ROLES)('role=%s is rejected with 403 (role gate)', async (role) => {
    gateRpc(role, [CLIENT_ID])
    const res = await GET(makeRequest(CLIENT_ID, '2026-09'))
    expect(res.status).toBe(403)
  })

  it('contractor-admin with client outside accessible_client_ids is rejected with 403 (tenant gate)', async () => {
    gateRpc('contractor-admin', [OTHER_CLIENT_ID])
    const res = await GET(makeRequest(CLIENT_ID, '2026-09'))
    expect(res.status).toBe(403)
  })

  it('contractor-admin with a failed accessible_client_ids() RPC is rejected with 403 (fail closed)', async () => {
    gateRpc('contractor-admin', null)
    const res = await GET(makeRequest(CLIENT_ID, '2026-09'))
    expect(res.status).toBe(403)
  })

  it.each([
    ['kwn', '2026-09'],
    [CLIENT_ID, '2026-13'],
    [CLIENT_ID, 'sept'],
  ])('bad params client=%s month=%s are rejected with 400 before any auth call', async (client, month) => {
    const res = await GET(makeRequest(client, month))
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('client monthly report Excel route — download', () => {
  beforeEach(() => vi.clearAllMocks())

  it('serves a no-store .xlsx attachment named after the client slug + month', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'current_user_role') return Promise.resolve({ data: 'contractor-admin' })
      if (fn === 'accessible_client_ids') return Promise.resolve({ data: [CLIENT_ID] })
      if (fn === 'get_client_monthly_report') {
        return Promise.resolve({
          data: [
            {
              source: 'booked', group_key: 'cot', group_label: 'Town of Cottesloe',
              service_name: 'Bulk Waste', is_mattress: false, is_extra: false, units: 114,
            },
          ],
          error: null,
        })
      }
      throw new Error(`UNEXPECTED rpc call: ${fn}`)
    })
    from.mockImplementation((table: string) => {
      if (table === 'client') {
        return query({
          data: {
            slug: 'vv', name: 'Verge Valet', legal_name: 'Western Metropolitan Regional Council',
            service_name: 'Verge Valet', primary_colour: '#414042', accent_colour: '#72b75c',
            mattress_closeout_stream: 'general',
          },
          error: null,
        })
      }
      if (table === 'sub_client') return query({ data: [{ id: 'sc1' }], error: null })
      if (table === 'service_rules') {
        return query({ data: [{ service: { name: 'Bulk Waste', category: { code: 'bulk' } } }], error: null })
      }
      throw new Error(`UNEXPECTED table: ${table}`)
    })

    const res = await GET(makeRequest(CLIENT_ID, '2026-09'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="vv-collections-2026-09.xlsx"')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(rpc).toHaveBeenCalledWith('get_client_monthly_report', {
      p_client_id: CLIENT_ID,
      p_month: '2026-09-01',
    })

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await res.arrayBuffer()) as ExcelJS.Buffer)
    const ws = wb.getWorksheet('Included')
    expect(ws?.getCell('B5').value).toBe('VV-2026-09')
    expect(ws?.getCell('A9').value).toBe('Town of Cottesloe')
    expect(ws?.getCell('B9').value).toBe(114)
  })
})
