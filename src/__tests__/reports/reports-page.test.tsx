import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * /admin/reports page-composition tests (VER-296).
 *
 * Renders the FULL ReportsClient (period selector → SlaDashboard → summary
 * stats) against a recording Supabase mock, covering what the pure-fn suites
 * and sla-card.test.tsx cannot: the PAGE wiring. Four guarantees:
 *
 *   1. CRITICAL regression guard — every VER-179 scorecard card still renders
 *      after the M2 extension, with real values flowing through the calc layer
 *      (eng review 02/07 T6, IRON RULE).
 *   2. Zero-data council view — empty states, never errors; contractor-only
 *      cards structurally absent (queries never fire — VER-288).
 *   3. A failed query renders a VISIBLE error state, never a silent zero.
 *   4. Tenant scoping — every table query carries `client_id` and every report
 *      RPC carries `p_client_id`. Public-SELECT tables don't scope themselves
 *      (§21), so the page-level filter IS the app-layer isolation contract;
 *      RLS-layer isolation is impersonation-tested in rls.test.ts.
 *
 * The genuine browser E2E boundary (unauthenticated → /auth via the real
 * proxy) lives in tests/e2e/admin-reports.spec.ts — see its header for why
 * a logged-in browser walk cannot run in CI.
 */

// ── Recording Supabase mock ──────────────────────────────────────────────────

interface RecordedQuery {
  table: string
  select: string
  head: boolean
  filters: [string, ...unknown[]][]
}
interface RecordedRpc {
  name: string
  args: Record<string, unknown>
}
interface MockResult {
  data: unknown
  error: { message: string } | null
  count?: number | null
}

const h = vi.hoisted(() => {
  const state = {
    executed: [] as { table: string; select: string; head: boolean; filters: [string, ...unknown[]][] }[],
    rpcs: [] as { name: string; args: Record<string, unknown> }[],
    respondTable: (() => ({ data: [], error: null, count: 0 })) as (q: {
      table: string
      select: string
      head: boolean
      filters: [string, ...unknown[]][]
    }) => { data: unknown; error: { message: string } | null; count?: number | null },
    respondRpc: (() => ({ data: [], error: null })) as (r: {
      name: string
      args: Record<string, unknown>
    }) => { data: unknown; error: { message: string } | null },
  }
  return state
})

vi.mock('@/lib/supabase/client', () => {
  const FILTER_METHODS = ['eq', 'neq', 'is', 'in', 'not', 'gte', 'lte', 'lt', 'gt', 'order', 'limit'] as const
  function makeBuilder(table: string): unknown {
    const q: RecordedQuery = { table, select: '', head: false, filters: [] }
    const b: Record<string, unknown> = {}
    b.select = (cols: string, opts?: { count?: string; head?: boolean }) => {
      q.select = cols
      q.head = opts?.head ?? false
      return b
    }
    for (const m of FILTER_METHODS) {
      b[m] = (...args: unknown[]) => {
        q.filters.push([m, ...args])
        return b
      }
    }
    // Executes on first await — records the query, resolves via the responder.
    b.then = (
      onF?: ((v: MockResult) => unknown) | null,
      onR?: ((e: unknown) => unknown) | null,
    ) => {
      h.executed.push(q)
      return Promise.resolve(h.respondTable(q)).then(onF, onR)
    }
    return b
  }
  return {
    createClient: () => ({
      from: (table: string) => makeBuilder(table),
      rpc: (name: string, args: Record<string, unknown> = {}) => {
        const rec: RecordedRpc = { name, args }
        h.rpcs.push(rec)
        return {
          then: (
            onF?: ((v: MockResult) => unknown) | null,
            onR?: ((e: unknown) => unknown) | null,
          ) => Promise.resolve(h.respondRpc(rec)).then(onF, onR),
        }
      },
    }),
  }
})

import { ReportsClient } from '@/app/(admin)/admin/reports/reports-client'
import type { PeriodFyRow } from '@/lib/reports/periods'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CLIENT_ID = 'client-aaaa-1111'

/** FY row bracketing the real "today" (AWST July–June) so `this-fy` resolves. */
function currentFyRow(): PeriodFyRow {
  const awst = new Date(Date.now() + 8 * 3600_000)
  const fyStartYear = awst.getUTCMonth() >= 6 ? awst.getUTCFullYear() : awst.getUTCFullYear() - 1
  return {
    id: 'fy-test',
    label: 'FY-TEST',
    start_date: `${fyStartYear}-07-01`,
    end_date: `${fyStartYear + 1}-06-30`,
    is_current: true,
  }
}

/** Current AWST month start — keeps trend fixtures inside the rolling-12 window. */
function currentMonthStartAwst(): string {
  const awst = new Date(Date.now() + 8 * 3600_000)
  return `${awst.getUTCFullYear()}-${String(awst.getUTCMonth() + 1).padStart(2, '0')}-01`
}

const rows = (data: unknown[]): MockResult => ({ data, error: null, count: data.length })

/**
 * Happy-path responder: enough data to clear every low-N threshold so the
 * scorecards render real percentages (query discrimination is by table +
 * select string — each card's select is unique per table).
 */
function happyTable(q: RecordedQuery): MockResult {
  switch (q.table) {
    case 'booking':
      // BC eligible set: 40 bookings (≥ CLEAN_LOW_N 20).
      if (q.select === 'id') return rows(Array.from({ length: 40 }, (_, i) => ({ id: `b${i}` })))
      if (q.select.startsWith('created_via'))
        return rows(
          Array.from({ length: 30 }, () => ({ created_via: 'resident', type: 'Residential', status: 'Confirmed' })),
        )
      // VOLMIX: 25 collections of Bulk Waste (≥ VOLUME_MIX_LOW_N 20).
      if (q.select.startsWith('booking_item'))
        return rows([
          {
            booking_item: [
              { no_services: 25, actual_services: null, is_extra: false, service: { name: 'Bulk Waste', waste_stream: 'general' } },
            ],
          },
        ])
      // Summary stats: 25 bookings by status, exact count matches rows (uncapped).
      if (q.select === 'status')
        return rows([
          ...Array.from({ length: 20 }, () => ({ status: 'Confirmed' })),
          ...Array.from({ length: 5 }, () => ({ status: 'Completed' })),
        ])
      return rows([])
    case 'non_conformance_notice':
      // BC miss query embeds the intake booking (select carries fy_id) — 2 of
      // the 40 eligible have contractor-fault NCNs → 38/40 = 95.0% clean.
      if (q.select.includes('fy_id')) return rows([{ booking_id: 'b0' }, { booking_id: 'b1' }])
      // Open-notices split: 1 contractor fault + 1 under investigation.
      return rows([
        { status: 'Issued', contractor_fault: true },
        { status: 'Disputed', contractor_fault: false },
      ])
    case 'nothing_presented':
      // 1 resident (presumed — Issued, not contractor fault).
      return rows([{ status: 'Issued', contractor_fault: false }])
    case 'collection_stop':
      // 25 stops (≥ ON_TIME_LOW_N 20) all completed on the scheduled AWST day.
      return rows(
        Array.from({ length: 25 }, () => ({
          completed_at: '2026-01-15T04:00:00Z',
          collection_date: { date: '2026-01-15', collection_area_id: 'area-1' },
        })),
      )
    case 'service_ticket':
      if (q.head) return { data: null, error: null, count: 3 } // open-tickets snapshot
      return rows([]) // SLA cards: tracking starts soon / no resolved tickets
    case 'notification_log':
      return rows(Array.from({ length: 25 }, () => ({ delivery_status: 'delivered' })))
    case 'booking_survey':
      // 6 submitted surveys (≥ RS_LOW_N 5): booking 6/6 good, service 3/6,
      // overall 0/6 — distinct values prove each card folds ITS OWN key.
      return rows([
        ...Array.from({ length: 3 }, () => ({
          responses: { booking_rating: 5, collection_rating: 4, overall_rating: 3 },
        })),
        ...Array.from({ length: 3 }, () => ({
          responses: { booking_rating: 4, collection_rating: 2, overall_rating: 3 },
        })),
      ])
    case 'refund_request':
      return rows([
        { amount_cents: 5000, status: 'pending' },
        { amount_cents: 2500, status: 'processed' },
      ])
    case 'collection_area':
      return rows([{ id: 'area-1', code: 'KWN-1', name: 'Area 1' }])
    case 'public_holiday':
      return rows([])
    default:
      return rows([])
  }
}

function happyRpc(r: RecordedRpc): MockResult {
  const month = currentMonthStartAwst()
  switch (r.name) {
    case 'get_rect_sla':
      return { data: [{ numerator: 8, denominator: 10, pct: 80 }], error: null }
    case 'get_property_penetration':
      return { data: [{ booked: 50, eligible: 1000 }], error: null }
    case 'get_collections_trend':
      return { data: [{ month, collections: 123 }], error: null }
    case 'get_on_time_monthly':
      return { data: [{ month, completed: 20, on_time: 19 }], error: null }
    case 'get_notices_monthly':
      return { data: [{ month, ncn_contractor: 1, ncn_other: 2, np_contractor: 0, np_other: 1 }], error: null }
    default:
      return { data: [], error: null }
  }
}

const emptyTable = (q: RecordedQuery): MockResult =>
  q.head ? { data: null, error: null, count: 0 } : rows([])
const emptyRpc = (): MockResult => ({ data: [], error: null })

function renderPage(viewerRole: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ReportsClient clientId={CLIENT_ID} fyRows={[currentFyRow()]} viewerRole={viewerRole} />
    </QueryClientProvider>,
  )
}

/** Scope queries to a single card via its label's card container. */
function card(label: string) {
  const el = screen.getByText(label).closest('div')
  if (!el) throw new Error(`card container not found for label: ${label}`)
  return within(el as HTMLElement)
}

beforeEach(() => {
  h.executed = []
  h.rpcs = []
  h.respondTable = emptyTable
  h.respondRpc = emptyRpc
})

// ── 1. VER-179 scorecard regression guard ────────────────────────────────────

describe('VER-179 SLA scorecard regression guard (contractor viewer)', () => {
  it('renders every pre-M2 card AND the M2 additions with values wired through', async () => {
    h.respondTable = happyTable
    h.respondRpc = happyRpc
    renderPage('contractor-admin')

    // Wait for the slowest composition seams to settle.
    await screen.findByText('95.0%') // BC: 38/40 clean
    await screen.findByText('Total Bookings') // summary stats settled

    // The full VER-179 card set — a missing label here means the M2 page
    // extension broke the existing scorecard (the IRON RULE this test guards).
    for (const label of [
      'Service Delivery',
      'On-Time Collection',
      'Rectification ≤ 2 Days',
      'Ticket First Response',
      'Ticket Resolution',
      'Self-Service Rate',
      'Notification Delivery',
      'Property Penetration',
      'Booking Rating',
      'Service Rating',
      'Overall Rating',
      'Service Breakdown',
      'Total Bookings',
      'Open Tickets',
      'Bookings by Status',
      'Refunds Pending',
      'Refunds Processed',
      // M2 additions (VER-294/297)
      'Open Notices',
      'Collections per Period',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // Section structure survives.
    expect(screen.getByText('Insights')).toBeInTheDocument()
    expect(screen.getByText('Service Level')).toBeInTheDocument()

    // Values flow through the calc layer, not just labels.
    expect(card('Service Delivery').getByText('95.0%')).toBeInTheDocument()
    expect(await card('On-Time Collection').findByText('100.0%')).toBeInTheDocument()
    expect(await card('Rectification ≤ 2 Days').findByText('80.0%')).toBeInTheDocument()
    expect(await card('Open Notices').findByText('3')).toBeInTheDocument()
    expect(
      card('Open Notices').getByText('1 contractor fault · 1 under investigation · 1 resident (incl. presumed)'),
    ).toBeInTheDocument()
    // Customer Satisfaction: each card folds ITS OWN responses key
    // (seeded: booking 6/6, service 3/6, overall 0/6).
    expect(screen.getByText('Customer Satisfaction')).toBeInTheDocument()
    expect(await card('Booking Rating').findByText('100.0%')).toBeInTheDocument()
    expect(card('Service Rating').getByText('50.0%')).toBeInTheDocument()
    expect(card('Overall Rating').getByText('0.0%')).toBeInTheDocument()
    expect(await screen.findByText('123')).toBeInTheDocument() // collections trend total
    expect(card('Total Bookings').getByText('25')).toBeInTheDocument()
    expect(card('Open Tickets').getByText('3')).toBeInTheDocument()
    expect(await screen.findByText('$50.00')).toBeInTheDocument() // refunds pending
    expect(screen.getByText('$25.00')).toBeInTheDocument() // refunds processed
    expect(screen.getByText('Confirmed')).toBeInTheDocument() // status breakdown bar
    expect(await screen.findByText('Bulk Waste')).toBeInTheDocument() // volmix bar

    // Nothing errored, and the uncapped summary shows no truncation notice.
    expect(screen.queryByText(/Couldn.t load/)).toBeNull()
    expect(screen.queryByText(/first 1,000 bookings/)).toBeNull()
  })
})

// ── 2. Zero-data council view ────────────────────────────────────────────────

describe('zero-data council view (client-admin)', () => {
  it('renders empty states — never errors — and omits contractor-only cards structurally', async () => {
    renderPage('client-admin')

    // Empty states, not blanks or errors.
    await screen.findByText('No collections yet') // BC
    expect(await screen.findByText('No completed stops')).toBeInTheDocument()
    expect(await screen.findByText('No rectifications')).toBeInTheDocument()
    expect(await screen.findByText('Tracking starts soon')).toBeInTheDocument()
    expect(await screen.findByText('No resolved tickets')).toBeInTheDocument()
    // One 'No responses yet' per satisfaction card (booking/service/overall).
    expect(await screen.findAllByText('No responses yet')).toHaveLength(3)
    expect(await card('Open Notices').findByText('No open notices')).toBeInTheDocument()
    expect(await screen.findByText('No collections match these filters.')).toBeInTheDocument()
    await screen.findByText('Total Bookings')
    expect(card('Total Bookings').getByText('0')).toBeInTheDocument()
    expect(screen.queryByText(/Couldn.t load/)).toBeNull()

    // VER-288 structural gating: contractor-only cards are not mounted…
    for (const label of [
      'Property Penetration',
      'Self-Service Rate',
      'Notification Delivery',
      'Refunds Pending',
      'Refunds Processed',
    ]) {
      expect(screen.queryByText(label)).toBeNull()
    }
    // …and their queries never fired.
    const tablesQueried = h.executed.map((q) => q.table)
    expect(tablesQueried).not.toContain('notification_log')
    expect(tablesQueried).not.toContain('refund_request')
    expect(h.rpcs.map((r) => r.name)).not.toContain('get_property_penetration')
  })
})

// ── 3. Failure is visible, never a silent zero ───────────────────────────────

describe('query failure states', () => {
  it('a failed RPC or table query renders an explicit error, not a blank/zero', async () => {
    h.respondTable = (q) =>
      q.table === 'booking' && q.select === 'status'
        ? { data: null, error: { message: 'boom' } }
        : happyTable(q)
    h.respondRpc = (r) =>
      r.name === 'get_rect_sla' ? { data: null, error: { message: 'rpc boom' } } : happyRpc(r)
    renderPage('contractor-admin')

    // Failed stats query → the amber banner, and the summary never renders.
    expect(await screen.findByText(/Couldn.t load the booking summary/)).toBeInTheDocument()
    expect(screen.queryByText('Total Bookings')).toBeNull()

    // Failed RPC → that card shows an explicit error state…
    expect(await card('Rectification ≤ 2 Days').findByText(/Couldn.t load/)).toBeInTheDocument()
    // …while unaffected cards still render their values.
    expect(await screen.findByText('95.0%')).toBeInTheDocument()
  })
})

// ── 4. Tenant scoping — the app-layer isolation contract ─────────────────────

describe('tenant scoping (VER-296 isolation, app layer)', () => {
  it('every table query carries client_id and every report RPC carries p_client_id', async () => {
    h.respondTable = happyTable
    h.respondRpc = happyRpc
    renderPage('contractor-admin')

    // Settle the whole surface (headline cards, refunds, trend RPCs).
    await screen.findByText('95.0%')
    await screen.findByText('$50.00')
    await screen.findByText('123')
    await waitFor(() =>
      expect(h.rpcs.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          'get_rect_sla',
          'get_property_penetration',
          'get_collections_trend',
          'get_on_time_monthly',
          'get_notices_monthly',
        ]),
      ),
    )
    // Sanity: this walk actually exercised the surface.
    expect(h.executed.length).toBeGreaterThanOrEqual(10)

    // public_holiday is jurisdiction reference data (no client_id column);
    // everything else MUST be tenant-filtered in the query itself — RLS on
    // public-SELECT tables reads cross-tenant by design (§21).
    const unscoped = h.executed.filter(
      (q) =>
        q.table !== 'public_holiday' &&
        !q.filters.some((f) => f[0] === 'eq' && f[1] === 'client_id' && f[2] === CLIENT_ID),
    )
    expect(unscoped.map((q) => `${q.table} · ${q.select}`)).toEqual([])

    const unscopedRpcs = h.rpcs.filter(
      (r) => r.name.startsWith('get_') && r.args.p_client_id !== CLIENT_ID,
    )
    expect(unscopedRpcs.map((r) => r.name)).toEqual([])
  })
})
