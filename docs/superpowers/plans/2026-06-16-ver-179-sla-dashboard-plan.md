> **End of Phase 2 — release to `main` and regenerate `types.ts` from prod before starting Phase 3:**
> ```bash
> pnpm supabase gen types typescript --project-id tfddjmplcizfirxqhotv > src/lib/supabase/types.ts
> # strip any CLI warnings the command appends to the file
> ```
> After regen, `Database['public']['Functions']['get_rect_sla']`, `['get_property_penetration']`, and `booking.Row.created_via` + the RPC `p_created_via?: string` arg are all available — Phase 3 typechecks against them.

---

## Phase 3 — Consumers (PR-B)

### Task 18: Integration — `page.tsx` resolves `currentFyId`

**Files:**
- Modify: `src/app/(admin)/admin/reports/page.tsx`

**Interfaces:**
- Consumes: `getCurrentAdminClient()` from `@/lib/admin/current-client`; `createClient()` from `@/lib/supabase/server`; `pickCurrentFyId` from `@/lib/reports/current-fy` (Task 12).
- Produces: `<ReportsClient clientId={...} currentFyId={pickCurrentFyId(rows)} />`. `ReportsClient`'s props are widened to `{ clientId: string; currentFyId: string | null }` in Task 19.

> This task and Task 19 land in the **same PR-B** (the `currentFyId` prop must exist for `tsc` to pass). Implement Task 19 first or alongside; they compile together.

- [ ] **Step 1: Rewrite `page.tsx` to fetch the FY rows and resolve via the tested helper**
```tsx
import { Suspense } from 'react'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { createClient } from '@/lib/supabase/server'
import { pickCurrentFyId } from '@/lib/reports/current-fy'
import { ReportsClient } from './reports-client'

export default async function ReportsPage() {
  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? ''

  const supabase = await createClient()
  const { data: financialYears } = await supabase
    .from('financial_year')
    .select('id, is_current')
  const currentFyId = pickCurrentFyId(financialYears)

  return (
    <Suspense>
      <ReportsClient clientId={clientId} currentFyId={currentFyId} />
    </Suspense>
  )
}
```

- [ ] **Step 2: Typecheck the integration compiles end-to-end**
Run: `pnpm tsc --noEmit`
Expected: PASS once `ReportsClient`'s props include `currentFyId: string | null` (Task 19). If running standalone before Task 19, `tsc` errors on the unknown prop — expected, resolved by Task 19.

- [ ] **Step 3: Commit** (bundle with Task 19's commit if implemented together; otherwise:)
```bash
git add "src/app/(admin)/admin/reports/page.tsx"
git commit -m "feat(ver-179): resolve current FY id in reports page.tsx and pass to ReportsClient

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Grounding:** `page.tsx` is currently 14 lines (`getCurrentAdminClient()` → `clientId` → `<ReportsClient>` inside `<Suspense>`); the diff adds the FY fetch + prop only, do not touch the `clientId` resolution. `financial_year.Row` has `id: string` + `is_current: boolean` and is public-SELECT, so the server anon client reads it with no extra RLS scoping — no service role.

### Task 19: Integration — `reports-client.tsx` data wiring (queries + folds)

**Files:**
- Modify: `src/app/(admin)/admin/reports/reports-client.tsx` (imports, props, extended bookings fetch, all 10 card queries, BC/SELFSVC folds)

**Interfaces:**
- Consumes (all from Phase 1 + the two Phase 2 RPCs): the pure fns + `awstDateFromUtc`. Exact contracts as defined in Tasks 2–11. **Note the two interface corrections vs the raw draft:** `computeVolumeMix().byStream` is a `Record<WasteStream, number>` (iterate with `Object.entries`), and `computePenetration()` returns `display` (no `booked`/`eligible`) — the consumer holds those scalars itself.
- Produces: nothing downstream — terminal consumer. Task 19 wires data; Task 19b (split out below) wires render.

> This task is split from the original Task 18 render work into **19 (data)** + **19b (render)** so each is independently reviewable. Both land in the same PR-B as Task 18.

- [ ] **Step 1: Replace the import block + component signature**

In `src/app/(admin)/admin/reports/reports-client.tsx`, replace the import block (top of file) and the component signature so the pure fns and `awstDateFromUtc` are available and the new prop is accepted:
```tsx
'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import { computeCleanCollection, CLEAN_TARGET_PCT } from '@/lib/reports/clean-collection'
import { computeOnTime, ON_TIME_TARGET_PCT } from '@/lib/reports/on-time'
import { computeRectSla, RECT_TARGET_PCT } from '@/lib/reports/rect'
import { computeServiceTicketSla } from '@/lib/reports/service-ticket-sla'
import { recoveryRate, RECOVERY_TARGET_PCT } from '@/lib/ncn/recovery-rate'
import { computeSelfServiceRate } from '@/lib/reports/self-service'
import { computeNotificationReliability } from '@/lib/reports/notification-reliability'
import { computeVolumeMix } from '@/lib/reports/volume-mix'
import { computePenetration } from '@/lib/reports/penetration'
import { computeResidentSatisfaction, RS_TARGET_PCT } from '@/lib/reports/resident-satisfaction'

export function ReportsClient({ clientId, currentFyId }: { clientId: string; currentFyId: string | null }) {
  const supabase = createClient()
  const [selectedArea, setSelectedArea] = useState('')
```

- [ ] **Step 2: Extend the existing bookings fetch + add BC/SELFSVC fold inputs**

Extend the existing `report-stats` bookings `.select` from `'status'` to the full set BC/SELFSVC need (spec §7), and fold the eligible/NCN/self-service inputs into the same `queryFn`. Replace the bookings query lines:
```tsx
      // Bookings by status (extended: id/fy_id/type/created_via feed BC + SELFSVC)
      let bookingQuery = supabase
        .from('booking')
        .select('id, status, fy_id, type, created_via')
      if (clientId) bookingQuery = bookingQuery.eq('client_id', clientId)
      if (selectedArea) bookingQuery = bookingQuery.eq('collection_area_id', selectedArea)
      const { data: bookings } = await bookingQuery
```
(`statusCounts` still reads `b.status` — unchanged. The bare `ncnCount`/`npCount`/`openTickets` cards stay untouched per the surgical-change rule.)

Append inside the `queryFn`, just before `return {`:
```tsx
      // BC eligible set — bookings that reached the field, FY-scoped (spec §3.1)
      const BC_FIELD_STATUSES = new Set([
        'Completed',
        'Non-conformance',
        'Nothing Presented',
        'Scheduled',
        'Missed Collection',
      ])
      const eligibleBookingIds = new Set(
        (bookings ?? [])
          .filter((b) => (currentFyId ? b.fy_id === currentFyId : true) && BC_FIELD_STATUSES.has(b.status))
          .map((b) => b.id),
      )

      // BC numerator — contractor-fault NCNs, scoped via the booking embed, then
      // intersected with the eligible set in the pure fn (spec §3.1)
      let bcNcnQuery = supabase
        .from('non_conformance_notice')
        .select('booking_id, contractor_fault, booking!inner(collection_area_id, fy_id, client_id, deleted_at)')
        .eq('client_id', clientId)
        .eq('contractor_fault', true)
        .is('booking.deleted_at', null)
      if (currentFyId) bcNcnQuery = bcNcnQuery.eq('booking.fy_id', currentFyId)
      if (selectedArea) bcNcnQuery = bcNcnQuery.eq('booking.collection_area_id', selectedArea)
      const { data: bcNcnRows } = await bcNcnQuery
      const contractorFaultNcnBookingIds = new Set(
        (bcNcnRows ?? []).map((r) => r.booking_id).filter((id): id is string => id != null),
      )

      // SELFSVC rows (spec §3.6 — pure fn excludes legacy/system/null + Cancelled itself)
      const selfServiceRows = (bookings ?? []).map((b) => ({
        created_via: b.created_via,
        type: b.type,
        status: b.status,
      }))
```
and add to the `return {` object:
```tsx
        eligibleBookingIds,
        contractorFaultNcnBookingIds,
        selfServiceRows,
```

- [ ] **Step 3: Add the WA-holidays query + the per-card queries**

After the `report-stats` `useQuery` block, add the queries below. Each is its own `useQuery` so a single failing card never blanks the dashboard; each keys on `selectedArea`/`clientId`/`currentFyId` per spec §5.5.
```tsx
  // WA public holidays — shared input for RECT + SR working-day math.
  const { data: waHolidays } = useQuery({
    queryKey: ['report-wa-holidays'],
    queryFn: async () => {
      const { data } = await supabase
        .from('public_holiday')
        .select('date')
        .eq('jurisdiction', 'WA')
      return new Set((data ?? []).map((h) => h.date as string))
    },
  })

  // ONTIME — per-stop, AWST closeout date vs scheduled date (spec §3.2)
  const { data: onTime } = useQuery({
    queryKey: ['report-on-time', clientId, selectedArea],
    enabled: !!clientId,
    queryFn: async () => {
      let q = supabase
        .from('collection_stop')
        .select('completed_at, collection_date:collection_date_id!inner(date, collection_area_id)')
        .eq('status', 'Completed')
        .not('completed_at', 'is', null)
        .eq('client_id', clientId)
      if (selectedArea) q = q.eq('collection_date.collection_area_id', selectedArea)
      const { data } = await q
      const stops = (data ?? []).map((row) => {
        const cd = row.collection_date as unknown as { date: string }
        return { completed_at: row.completed_at as string, scheduledDate: cd.date }
      })
      return computeOnTime(stops)
    },
  })

  // RECT — rows from the RPC; pure fn re-validates working-days ≤ 2 (spec §3.3)
  const { data: rect } = useQuery({
    queryKey: ['report-rect', clientId, selectedArea, !!waHolidays],
    enabled: !!clientId && !!waHolidays,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_rect_sla', {
        p_client_id: clientId,
        p_area_id: selectedArea || null,
      })
      if (error) throw error
      // get_rect_sla returns {numerator, denominator, pct}; re-validate via the
      // pure fn would require the raw rows, which the RPC doesn't expose. The RPC
      // IS the authoritative compute (mirrors rect.ts); surface its shape directly.
      const row = (Array.isArray(data) ? data[0] : data) as
        | { numerator: number; denominator: number; pct: number | null }
        | undefined
      const denominator = Number(row?.denominator ?? 0)
      const numerator = Number(row?.numerator ?? 0)
      return {
        numerator,
        denominator,
        pct: row?.pct == null ? null : Number(row.pct),
        isEmpty: denominator === 0,
        isLowN: denominator > 0 && denominator < 5,
      }
    },
  })

  // SR — service tickets, area filter only on booking-linked tickets (spec §3.4)
  const { data: serviceTickets } = useQuery({
    queryKey: ['report-sr', clientId, selectedArea, !!waHolidays],
    enabled: !!clientId && !!waHolidays,
    queryFn: async () => {
      const { data } = await supabase
        .from('service_ticket')
        .select('created_at, first_response_at, resolved_at, closed_at, booking:booking_id(collection_area_id)')
        .eq('client_id', clientId)
      const tickets = (data ?? [])
        .filter((t) => {
          if (!selectedArea) return true
          const b = t.booking as unknown as { collection_area_id: string } | null
          return b?.collection_area_id === selectedArea
        })
        .map((t) => ({
          createdAtAwst: awstDateFromUtc(new Date(t.created_at as string)),
          firstResponseAtAwst: t.first_response_at
            ? awstDateFromUtc(new Date(t.first_response_at as string))
            : null,
          resolvedAtUtc: (t.resolved_at ?? t.closed_at) as string | null,
        }))
      return computeServiceTicketSla({ tickets, waHolidays: waHolidays ?? new Set<string>() })
    },
  })

  // RECOVERY — split-query + stitch; NEVER embed the rebooked booking (spec §3.5)
  const { data: recovery } = useQuery({
    queryKey: ['report-recovery', clientId, selectedArea],
    enabled: !!clientId,
    queryFn: async () => {
      const ncnQ = supabase
        .from('non_conformance_notice')
        .select('id, rescheduled_booking_id, booking:booking!non_conformance_notice_booking_id_fkey(collection_area_id)')
        .eq('client_id', clientId)
      const npQ = supabase
        .from('nothing_presented')
        .select('id, rescheduled_booking_id, booking:booking!nothing_presented_booking_id_fkey(collection_area_id)')
        .eq('client_id', clientId)
      const [{ data: ncn }, { data: np }] = await Promise.all([ncnQ, npQ])

      const inArea = (b: unknown) =>
        !selectedArea || (b as { collection_area_id: string } | null)?.collection_area_id === selectedArea
      const notices = [...(ncn ?? []), ...(np ?? [])]
        .filter((n) => inArea(n.booking))
        .map((n) => ({ rescheduledBookingId: n.rescheduled_booking_id as string | null }))

      const rescheduledIds = notices
        .map((n) => n.rescheduledBookingId)
        .filter((id): id is string => id != null)
      const rebookedStatusById = new Map<string, string>()
      if (rescheduledIds.length) {
        const { data: rebooked } = await supabase
          .from('booking')
          .select('id, status')
          .in('id', rescheduledIds)
        for (const b of rebooked ?? []) rebookedStatusById.set(b.id, b.status)
      }
      return recoveryRate(notices, rebookedStatusById)
    },
  })

  // NOTIF — email only, NO area filter (spec §3.7)
  const { data: notif } = useQuery({
    queryKey: ['report-notif', clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const { data } = await supabase
        .from('notification_log')
        .select('delivery_status')
        .eq('client_id', clientId)
        .eq('channel', 'email')
        .not('delivery_status', 'is', null)
      return computeNotificationReliability((data ?? []).map((r) => r.delivery_status as string))
    },
  })

  // VOLMIX — quote "Pending Payment" (space) to avoid PGRST100 (spec §3.8)
  const { data: volMix } = useQuery({
    queryKey: ['report-volmix', clientId, selectedArea],
    enabled: !!clientId,
    queryFn: async () => {
      let q = supabase
        .from('booking')
        .select('booking_item(no_services, actual_services, is_extra, service!inner(name, waste_stream))')
        .eq('client_id', clientId)
        .not('status', 'in', '("Cancelled","Pending Payment")')
      if (selectedArea) q = q.eq('collection_area_id', selectedArea)
      const { data } = await q
      const rows = (data ?? []).flatMap((b) =>
        (b.booking_item ?? []).map((bi) => {
          const svc = bi.service as unknown as { name: string; waste_stream: string }
          return {
            no_services: bi.no_services as number,
            actual_services: bi.actual_services as number | null,
            is_extra: bi.is_extra as boolean,
            waste_stream: svc.waste_stream as 'general' | 'green' | 'ancillary' | 'illegal_dumping',
            service_name: svc.name,
          }
        }),
      )
      return computeVolumeMix(rows)
    },
  })

  // PENETRATION — RPC (COUNT DISTINCT + 107k-row denom can't be client-side) (spec §3.9)
  const { data: penetration } = useQuery({
    queryKey: ['report-penetration', clientId, selectedArea],
    enabled: !!clientId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_property_penetration', {
        p_client_id: clientId,
        p_area_id: selectedArea || null,
      })
      if (error) throw error
      const row = (Array.isArray(data) ? data[0] : data) as { booked: number; eligible: number } | undefined
      return computePenetration({ booked: Number(row?.booked ?? 0), eligible: Number(row?.eligible ?? 0) })
    },
  })

  // RS — extract Number(responses.overall_rating) in JS, never jsonb .gte (spec §3.10)
  const { data: residentSat } = useQuery({
    queryKey: ['report-rs', clientId, selectedArea],
    enabled: !!clientId,
    queryFn: async () => {
      const q = selectedArea
        ? supabase
            .from('booking_survey')
            .select('responses, booking!inner(collection_area_id)')
            .eq('client_id', clientId)
            .not('submitted_at', 'is', null)
            .eq('booking.collection_area_id', selectedArea)
        : supabase
            .from('booking_survey')
            .select('responses')
            .eq('client_id', clientId)
            .not('submitted_at', 'is', null)
      const { data } = await q
      return computeResidentSatisfaction(
        (data ?? []).map((r) => ({ responses: r.responses as unknown })),
      )
    },
  })

  // BC + SELFSVC fold from the already-fetched report-stats rows
  const bc =
    stats &&
    computeCleanCollection({
      eligibleBookingIds: stats.eligibleBookingIds,
      contractorFaultNcnBookingIds: stats.contractorFaultNcnBookingIds,
    })
  const selfSvc = stats && computeSelfServiceRate(stats.selfServiceRows)
```

- [ ] **Step 4: Typecheck**
Run: `pnpm tsc --noEmit`
Expected: PASS — gated on the Phase-2 RPCs + `created_via` column being in the regenerated `types.ts`. If `supabase.rpc('get_rect_sla' | 'get_property_penetration')` errors as "not assignable", the regen has not happened — block on it, do not hand-cast.

- [ ] **Step 5: Commit** (bundle with Task 19b)

**Wiring notes:** RECT surfaces the RPC's `{numerator, denominator, pct}` directly (the RPC IS the authoritative compute mirroring `rect.ts`; the pure fn validates the same arithmetic in unit tests). All multi-FK NCN/NP embeds use explicit `!fk_name`. `"Pending Payment"` is double-quoted in the `.not(...,'in',...)` value to avoid PGRST100.

### Task 19b: Integration — `reports-client.tsx` render (10 cards)

**Files:**
- Modify: `src/app/(admin)/admin/reports/reports-client.tsx` (render helpers + SLA scorecard grid + insight grid)

**Interfaces:**
- Consumes: the query results bound in Task 19 (`bc`, `onTime`, `rect`, `serviceTickets`, `recovery`, `selfSvc`, `notif`, `volMix`, `penetration`, `residentSat`) + the exported target consts.
- Produces: rendered UI. Terminal.

- [ ] **Step 1: Add the shared scorecard render helper above `return (`**
```tsx
  // Shared chrome for an SLA scorecard card (spec §5.6 — amber below target, never red).
  function ScoreCard({
    label,
    state,
    fraction,
    pct,
    target,
    suffix,
  }: {
    label: string
    state: 'empty' | 'low-n' | 'at-n'
    fraction: string
    pct: number | null
    target?: number
    suffix?: string
  }) {
    let numeralClass = 'text-[#293F52]'
    if (state === 'at-n' && pct != null && target != null) {
      numeralClass = pct >= target ? 'text-emerald-600' : 'text-amber-600'
    }
    return (
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
        {state === 'empty' ? (
          <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-gray-300">—</p>
        ) : state === 'low-n' ? (
          <>
            <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">{fraction}</p>
            <p className="mt-0.5 text-[11px] font-medium text-blue-500">Building data</p>
          </>
        ) : (
          <>
            <p className={`mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold ${numeralClass}`}>
              {pct != null ? `${pct.toFixed(1)}%` : '—'}{' '}
              <span className="text-sm font-semibold text-gray-400">· {fraction}</span>
            </p>
            {target != null && (
              <p className="mt-0.5 text-[11px] font-medium text-gray-400">
                Target {target}%{suffix ? ` · ${suffix}` : ''}
              </p>
            )}
          </>
        )}
      </div>
    )
  }

  const stateOf = (m?: { isEmpty: boolean; isLowN: boolean } | null): 'empty' | 'low-n' | 'at-n' =>
    !m ? 'empty' : m.isEmpty ? 'empty' : m.isLowN ? 'low-n' : 'at-n'
```

- [ ] **Step 2: Insert the SLA scorecard grid (7 cards) into the existing `space-y-6` block, after the Summary-cards grid**
```tsx
            {/* SLA scorecard cards (VER-179) */}
            <div>
              <h2 className="mb-3 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">SLA Scorecard</h2>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <ScoreCard
                  label="Clean Collection"
                  state={stateOf(bc)}
                  fraction={bc ? `${bc.eligible - bc.miss} / ${bc.eligible} clean` : ''}
                  pct={bc?.pct ?? null}
                  target={CLEAN_TARGET_PCT}
                />
                <ScoreCard
                  label="On-Time Collection"
                  state={stateOf(onTime)}
                  fraction={onTime ? `${onTime.onTime} / ${onTime.completed}` : ''}
                  pct={onTime?.pct ?? null}
                  target={ON_TIME_TARGET_PCT}
                />
                <ScoreCard
                  label="Rectified ≤ 2 working days"
                  state={stateOf(rect)}
                  fraction={rect ? `${rect.numerator} / ${rect.denominator}` : ''}
                  pct={rect?.pct ?? null}
                  target={RECT_TARGET_PCT}
                />
                <ScoreCard
                  label="SR Resolution < 30 days"
                  state={stateOf(serviceTickets?.resolved)}
                  fraction={serviceTickets ? `${serviceTickets.resolved.withinTarget} / ${serviceTickets.resolved.n}` : ''}
                  pct={serviceTickets?.resolved.pct ?? null}
                  target={90}
                  suffix={
                    serviceTickets && serviceTickets.responded.isEmpty
                      ? 'first-response tracking starts after FRSTAMP'
                      : serviceTickets && serviceTickets.responded.pct != null
                        ? `first response ${serviceTickets.responded.pct.toFixed(0)}% ≤ 3wd`
                        : undefined
                  }
                />
                <ScoreCard
                  label="Recovery Rate"
                  state={stateOf(recovery)}
                  fraction={recovery ? `${recovery.recovered} / ${recovery.recoverable}` : ''}
                  pct={recovery?.rate ?? null}
                  target={RECOVERY_TARGET_PCT}
                />
                <ScoreCard
                  label="Self-Service Rate"
                  state={stateOf(selfSvc)}
                  fraction={selfSvc ? `${selfSvc.selfServed} / ${selfSvc.inScope} resident` : ''}
                  pct={selfSvc?.pct ?? null}
                  target={80}
                  suffix={selfSvc && selfSvc.excludedLegacy > 0 ? `${selfSvc.excludedLegacy} earlier excluded` : undefined}
                />
                <ScoreCard
                  label="Notification Reliability"
                  state={stateOf(notif)}
                  fraction={notif ? `${notif.positive} / ${notif.tracked}` : ''}
                  pct={notif?.pct ?? null}
                  target={98}
                  suffix="email only"
                />
              </div>
            </div>
```

- [ ] **Step 3: Insert the insight grid (3 cards) directly below — note the `Object.entries(byStream)` fix and `penetration.display` usage**
```tsx
            {/* Insight cards (VER-179) — directional, never pass/fail coloured */}
            <div>
              <h2 className="mb-3 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">Insights</h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {/* VOLMIX */}
                <div className="rounded-xl bg-white p-5 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {volMix && volMix.totalCollections > 0 ? 'Collections (booked)' : 'Volume & Mix'}
                  </p>
                  {!volMix || volMix.isEmpty ? (
                    <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-gray-300">—</p>
                  ) : (
                    <>
                      <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">
                        {volMix.totalCollections}
                      </p>
                      {volMix.isLowN ? (
                        <p className="mt-0.5 text-[11px] font-medium text-blue-500">Building data</p>
                      ) : (
                        <div className="mt-3 space-y-1.5">
                          {Object.entries(volMix.byStream).map(([stream, qty]) => (
                            <div key={stream} className="flex items-center gap-2">
                              <span className="w-24 text-[11px] capitalize text-gray-500">{stream.replace('_', ' ')}</span>
                              <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                                <div
                                  className="h-full rounded-full bg-[#293F52]"
                                  style={{ width: `${Math.max(2, (qty / volMix.totalCollections) * 100)}%` }}
                                />
                              </div>
                              <span className="w-10 text-right text-[11px] font-semibold text-gray-700">{qty}</span>
                            </div>
                          ))}
                          <p className="pt-1 text-[11px] text-gray-400">
                            {volMix.freeUnits} free · {volMix.extraUnits} extra
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* PENETRATION */}
                <div className="rounded-xl bg-white p-5 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Property Penetration</p>
                  {!penetration || penetration.isEmpty ? (
                    <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-gray-300">
                      No eligible properties
                    </p>
                  ) : penetration.isLowN ? (
                    <>
                      <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">
                        {penetration.display}
                      </p>
                      <p className="mt-0.5 text-[11px] font-medium text-blue-500">Building data</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">
                        {penetration.pct != null ? `${penetration.pct.toFixed(2)}%` : '—'}
                      </p>
                      <p className="mt-0.5 text-[11px] font-medium text-gray-400">{penetration.display} eligible</p>
                    </>
                  )}
                </div>

                {/* RS */}
                <div className="rounded-xl bg-white p-5 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Resident Satisfaction</p>
                  {!residentSat || residentSat.isEmpty ? (
                    <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-gray-300">
                      No responses yet
                    </p>
                  ) : residentSat.isLowN ? (
                    <>
                      <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">
                        {residentSat.good} of {residentSat.n} rated good
                      </p>
                      <p className="mt-0.5 text-[11px] font-medium text-blue-500">Building data</p>
                    </>
                  ) : (
                    <>
                      <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-bold text-[#293F52]">
                        {residentSat.pct != null ? `${residentSat.pct.toFixed(1)}%` : '—'}
                      </p>
                      <p className="mt-0.5 text-[11px] font-medium text-gray-400">
                        {residentSat.n} responses · Target {RS_TARGET_PCT}%
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
```

- [ ] **Step 4: Typecheck, lint, build**
Run: `pnpm tsc --noEmit && pnpm lint && pnpm build`
Expected: PASS. Blockers are the Phase-2 RPCs + `created_via` types — block on the regen, don't hand-cast.

- [ ] **Step 5: Commit (Tasks 18 + 19 + 19b together — one PR-B consumer commit)**
```bash
git add "src/app/(admin)/admin/reports/page.tsx" "src/app/(admin)/admin/reports/reports-client.tsx"
git commit -m "feat(ver-179): wire all 10 SLA dashboard cards into reports-client

- resolve currentFyId in page.tsx server shell, pass as prop
- extend bookings fetch to id/status/fy_id/type/created_via for BC + SELFSVC
- 7 scorecard cards (BC, ONTIME, RECT, SR, RECOVERY, SELFSVC, NOTIF) + 3 insight
  cards (VOLMIX, PENETRATION, RS) folded via pure fns
- get_rect_sla + get_property_penetration via supabase.rpc; everything else
  client PostgREST per spec 5.2
- empty / low-n (Building data) / at-n render states; amber-below-target,
  green-at-target, never error-red (spec 5.6)
- area filter on all cards except NOTIF (spec 5.5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Notes:** the pre-existing bare cards (`ncnCount`, `npCount`, `openTickets`, refund summary, Bookings-by-status) are left untouched per the surgical-change rule — BC sits alongside the old NCN card, it does not replace it. SR first-response stays inert (`isEmpty`) until FRSTAMP has stamped tickets; RS returns rows only after the staff-SELECT policy is on `main`; both render their honest empty state until then.

### Task 20: Integration — `create-booking` EF + MUD action stamp `created_via` (CBSTAMP PR-B)

**Files:**
- Modify: `supabase/functions/create-booking/index.ts`
- Modify: `src/app/(admin)/admin/properties/[id]/book/actions.ts`
- Modify: `src/lib/audit/field-labels.ts`
- Test: `src/__tests__/create-booking-created-via.test.ts`

**Interfaces:**
- Consumes (from Task 7): `classifyCreator({ actingUserRole, actingUserEmail, contactEmail, hasSession }) => { createdVia: 'resident' | 'admin' }`.
- Consumes (from Task 17 PR-A, already on prod): `create_booking_with_capacity_check(..., p_created_via text DEFAULT 'system')`.
- Produces: every resident/guest self-booking lands `booking.created_via='resident'`; every staff/MUD on-behalf booking lands `'admin'`. SELFSVC (Task 7) depends on this column being populated.

- [ ] **Step 1: Write the failing test** (mirrors the EF's classification decision against the pure fn)
```ts
// src/__tests__/create-booking-created-via.test.ts
import { describe, it, expect } from 'vitest'
import { classifyCreator } from '@/lib/bookings/classify-creator'

describe('create-booking created_via classification', () => {
  it('guest OTP self-booking (no session) → resident', () => {
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: null,
        contactEmail: 'jane@resident.com',
        hasSession: false,
      }).createdVia,
    ).toBe('resident')
  })

  it('authed resident booking for own email → resident', () => {
    expect(
      classifyCreator({
        actingUserRole: 'resident',
        actingUserEmail: 'jane@resident.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('resident')
  })

  it('staff on-behalf booking for a resident → admin', () => {
    expect(
      classifyCreator({
        actingUserRole: 'contractor-admin',
        actingUserEmail: 'staff@dmwaste.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })

  it('authed user booking for a DIFFERENT email (collision/family) → admin', () => {
    expect(
      classifyCreator({
        actingUserRole: 'resident',
        actingUserEmail: 'someone@else.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })

  it('client-staff role with matching email is still admin (staff role wins)', () => {
    expect(
      classifyCreator({
        actingUserRole: 'client-staff',
        actingUserEmail: 'staff@kwinana.gov.au',
        contactEmail: 'staff@kwinana.gov.au',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm test src/__tests__/create-booking-created-via.test.ts`
Expected: FAIL until Task 7 is merged on this branch; once it is, these pass (confirming the EF's intended mapping).

- [ ] **Step 3: Wire the EF + action + audit label**

In `supabase/functions/create-booking/index.ts`, add a helper near the other module helpers (the EF can't import from `src/`, so it inlines the same decision — role resolved via the **service-role** client since `user_roles` SELECT is RLS-gated):
```ts
type CreatedVia = 'resident' | 'admin'

async function resolveCreatedVia(
  supabaseService: ReturnType<typeof createClient>,
  actingUserId: string | null | undefined,
  actingUserEmail: string | null | undefined,
  contactEmail: string,
): Promise<CreatedVia> {
  const STAFF_ROLES = new Set([
    'contractor-admin',
    'contractor-staff',
    'client-admin',
    'client-staff',
  ])
  if (!actingUserId) return 'resident' // guest OTP / no session

  const { data: roleRow } = await supabaseService
    .from('user_roles')
    .select('role')
    .eq('user_id', actingUserId)
    .limit(1)
    .maybeSingle()

  const role = roleRow?.role ?? null
  const emailMismatch =
    !!actingUserEmail &&
    actingUserEmail.toLowerCase() !== contactEmail.toLowerCase()

  return role && STAFF_ROLES.has(role) ? 'admin' : emailMismatch ? 'admin' : 'resident'
}
```
Resolve it once (the acting user is already fetched as `actingUserEarly`):
```ts
    const createdVia = await resolveCreatedVia(
      supabaseService,
      actingUserEarly?.id,
      actingUserEarly?.email,
      contact.email,
    )
```
Pass `p_created_via: createdVia` on the main `create_booking_with_capacity_check` call.

> Edit-in-place path: only add `p_created_via` to the `update_booking_items_in_place` call **if PR-A widened that RPC's signature**. Task 17 PR-A re-states only the create + ID RPCs (per spec §4.2), so by default **do NOT** add it to the edit-in-place call — an edit never changes the original channel. Confirm against the merged PR-A migration before editing.

MUD admin-on-behalf action — `src/app/(admin)/admin/properties/[id]/book/actions.ts` runs under the staff JWT and the booking is definitionally admin-created. Pass the literal `p_created_via: 'admin'` on its `.rpc('create_booking_with_capacity_check', { ... })` call.

Audit label — `src/lib/audit/field-labels.ts`, add under the Booking block:
```ts
  created_via: 'Created Via',
```

- [ ] **Step 4: Run test + typecheck**
Run: `pnpm test src/__tests__/create-booking-created-via.test.ts && pnpm tsc --noEmit`
Expected: PASS — all five classification cases green; `tsc` clean (regen'd `types.ts` from PR-A includes `p_created_via` on the RPC + `created_via` on `booking.Row`).

Manual EF smoke (after deploy): create one guest `/book/confirm` booking and one `/admin/properties/[id]/book` MUD booking, then `select id, created_via from booking order by created_at desc limit 2` — expect `resident` and `admin`.

- [ ] **Step 5: Commit**
```bash
git add supabase/functions/create-booking/index.ts \
        "src/app/(admin)/admin/properties/[id]/book/actions.ts" \
        src/lib/audit/field-labels.ts \
        src/__tests__/create-booking-created-via.test.ts
git commit -m "feat(ver-179): stamp booking.created_via from create-booking EF + MUD action (CBSTAMP PR-B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

**Grounding:** the EF already fetches the acting user once as `actingUserEarly` via `supabaseAnon.auth.getUser()` — reuse it, don't add a second `getUser()`. The role lookup MUST use `supabaseService` (service-role) — a guest/resident JWT can't read `user_roles` staff rows under RLS, which would misclassify staff as `resident`. The MUD action already passes `p_type: 'MUD'` under the staff JWT; the literal `'admin'` is correct and needs no `classifyCreator` call. Gated on Task 17 PR-A being released to `main` + `types.ts` regenerated, else `tsc` fails on the unknown `p_created_via` param.

---

## Spec Coverage

| Spec § | Card / Migration | Task(s) | Status |
|---|---|---|---|
| §3.1 | **BC** Clean Collection | Task 2 (calc) + Task 19/19b (query+render) | ✅ Covered |
| §3.2 | **ONTIME** On-Time Collection | Task 3 (calc) + Task 19/19b | ✅ Covered |
| §3.3 | **RECT** Rectification ≤2 wd | Task 1 (helper) + Task 4 (calc) + Task 14 (RPC) + Task 19/19b | ✅ Covered |
| §3.4 | **SR** Service Ticket SLA | Task 1 (helper) + Task 5 (calc) + Task 16 (FRSTAMP) + Task 19/19b | ✅ Covered (first-response inert until FRSTAMP on prod, by design) |
| §3.5 | **RECOVERY** Recovery Rate | Task 6 (calc) + Task 19/19b | ✅ Covered |
| §3.6 | **SELFSVC** Self-Service Rate | Task 7 (calc + classifier) + Task 17 (column PR-A) + Task 20 (EF PR-B) + Task 19/19b | ✅ Covered |
| §3.7 | **NOTIF** Notification Reliability | Task 8 (calc) + Task 19/19b | ✅ Covered (email-only per §2) |
| §3.8 | **VOLMIX** Volume & Mix | Task 9 (calc) + Task 19/19b | ✅ Covered |
| §3.9 | **PENETRATION** Property Penetration | Task 10 (calc) + Task 13 (RPC) + Task 19/19b | ✅ Covered |
| §3.10 | **RS** Resident Satisfaction | Task 11 (calc) + Task 15 (RS-RLS) + Task 19/19b | ✅ Covered (zero data until policy on prod, by design) |
| §4.1 | FRSTAMP migration | Task 16 | ✅ Covered (single PR — column pre-exists) |
| §4.2 | CBSTAMP migration + EF | Task 17 (PR-A) + Task 20 (PR-B) | ✅ Covered |
| §4.3 | RS-RLS staff SELECT policy | Task 15 | ✅ Covered |
| §5.1 | Pure-fn calc layer | Tasks 1–11 | ✅ Covered |
| §5.2 | Query strategy (PostgREST + 2 RPCs) | Tasks 13, 14, 19 | ✅ Covered |
| §5.3 | Current-FY plumbing | Task 12 (resolver) + Task 18 (page.tsx) | ✅ Covered |
| §5.4 | Empty/low-n thresholds | Each calc task exports its `LOW_N` | ✅ Covered (20/5/10/25 per card) |
| §5.5 | Area filter | Task 19 (per-card queryKeys; NOTIF exempt) | ✅ Covered |
| §5.6 | Card UI & colour | Task 19b (`ScoreCard`, amber/info-blue) | ✅ Covered |
| §6 | Testing plan (TDD 100% pure fns) | Each calc task Steps 1–4; smoke in Tasks 13–17 | ✅ Covered |

**Coverage gaps / deferred (per spec §2, intentionally not built):** NCN damage/non-damage split; SMS delivery rate (NOTIF email-only); `sla_config` table wiring (constants hardcoded); strata self-service portal logic. **Design-decision notes carried into tasks:** the `update_booking_items_in_place` `p_created_via` wiring (Task 20) is conditional on whether PR-A widened that RPC — default is to leave it untouched. No unmapped spec card or migration remains.

---

Relevant absolute paths: design spec `/Users/danieltaylor/GitHub/verco/docs/superpowers/specs/2026-06-16-ver-179-sla-dashboard-design.md`; target screen `/Users/danieltaylor/GitHub/verco/src/app/(admin)/admin/reports/page.tsx` + `/Users/danieltaylor/GitHub/verco/src/app/(admin)/admin/reports/reports-client.tsx`.