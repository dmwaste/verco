import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Pins the two authz gates on the client monthly report PDF route: the
 * contractor-admin-only role check, and the accessible_client_ids() tenant
 * check (§21 — never trust the public-SELECT `client` table alone). This is
 * an invoice-backing document, so both gates must fail closed. Downstream
 * calls (client/report data fetch, PDF render) are mocked to throw — if a
 * gate is ever bypassed, the test fails loudly instead of silently
 * rendering a PDF.
 */

const { rpc, from } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(() => {
    throw new Error('UNEXPECTED: gate bypassed, reached supabase.from()')
  }),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ rpc, from })),
}))

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn(() => {
    throw new Error('UNEXPECTED: gate bypassed, reached renderToBuffer()')
  }),
}))

vi.mock('@/lib/reports/client-monthly/pdf', () => ({
  ClientMonthlyReportPdf: vi.fn(() => {
    throw new Error('UNEXPECTED: gate bypassed, reached ClientMonthlyReportPdf()')
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/(admin)/admin/reports/client-report/pdf/route'

const CLIENT_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_CLIENT_ID = '00000000-0000-4000-8000-000000000000'

function makeRequest(clientId: string, month: string) {
  return new NextRequest(
    `https://admin.verco.au/admin/reports/client-report/pdf?client=${clientId}&month=${month}`
  )
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

describe('client monthly report PDF route — authz gates', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(DENIED_ROLES)('role=%s is rejected with 403 (role gate)', async (role) => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'current_user_role') return Promise.resolve({ data: role })
      if (fn === 'accessible_client_ids') return Promise.resolve({ data: [CLIENT_ID] })
      throw new Error(`UNEXPECTED rpc call: ${fn}`)
    })

    const res = await GET(makeRequest(CLIENT_ID, '2026-07'))
    expect(res.status).toBe(403)
  })

  it('contractor-admin with client outside accessible_client_ids is rejected with 403 (tenant gate)', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'current_user_role') return Promise.resolve({ data: 'contractor-admin' })
      if (fn === 'accessible_client_ids') return Promise.resolve({ data: [OTHER_CLIENT_ID] })
      throw new Error(`UNEXPECTED rpc call: ${fn}`)
    })

    const res = await GET(makeRequest(CLIENT_ID, '2026-07'))
    expect(res.status).toBe(403)
  })

  it('contractor-admin with a failed accessible_client_ids() RPC is rejected with 403 (fail closed)', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'current_user_role') return Promise.resolve({ data: 'contractor-admin' })
      if (fn === 'accessible_client_ids')
        return Promise.resolve({ data: null, error: { message: 'boom' } })
      throw new Error(`UNEXPECTED rpc call: ${fn}`)
    })

    const res = await GET(makeRequest(CLIENT_ID, '2026-07'))
    expect(res.status).toBe(403)
  })
})
