import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import { awstDateFromUtc } from '@/lib/booking/schedule-transition'
import {
  idDateAccessForRole,
  isIdDateBookable,
  type IdDateAccess,
  type IdDateGate,
} from '@/lib/booking/id-date-access'
import { IdRequestForm, type AreaOption, type IdDateOption } from './id-request-form'

export default async function NewIdRequestPage() {
  const currentClient = await getCurrentAdminClient()
  const supabase = await createClient()

  let areas: AreaOption[] = []
  // The gate columns ride along with each row so the pooled/unpooled filters
  // below can judge a date; IdRequestForm only reads the IdDateOption fields.
  let dates: (IdDateOption & IdDateGate)[] = []
  let isContractorAdmin = false
  let access: IdDateAccess = 'open-only'

  if (currentClient) {
    // Sub-client narrowing (VER-216): a client-tier user scoped to one
    // sub-client only sees that sub-client's areas — the RPC would reject a
    // cross-sub-client submit anyway, so don't offer dead-end options.
    const {
      data: { user },
    } = await supabase.auth.getUser()
    const { data: userRole } = await supabase
      .from('user_roles')
      .select('sub_client_id, role')
      .eq('user_id', user?.id ?? '')
      .eq('is_active', true)
      .maybeSingle()
    const subClientId = userRole?.sub_client_id ?? null
    // Which dates this role may book onto — contractor-admin overrides any
    // closure, office/council staff may book inside the T-3 lock while spots
    // remain, rangers get open dates only. Same rule as the RPC's closure gate.
    access = idDateAccessForRole(userRole?.role)
    isContractorAdmin = access === 'any-open-or-closed'

    // collection_area / collection_date are public-SELECT — RLS does not
    // tenant-scope them (CLAUDE.md §21), so filter by the switcher client.
    let areaQuery = supabase
      .from('collection_area')
      .select('id, code, name, capacity_pool_id')
      .eq('client_id', currentClient.id)
      .eq('is_active', true)
      .order('code')
    if (subClientId) {
      areaQuery = areaQuery.eq('sub_client_id', subClientId)
    }
    const { data: areaRows } = await areaQuery
    areas = (areaRows ?? []).map(({ id, code, name }) => ({ id, code, name }))

    if (areas.length > 0) {
      // AWST calendar date — toISOString() is UTC and resolves to *yesterday*
      // between midnight and 8am Perth time.
      const now = new Date()
      const today = awstDateFromUtc(now)
      // 90-day horizon keeps the row count well under the cap below — without
      // it, a tenant with many long-seeded areas could exceed the cap and
      // silently starve later-sorting areas of their dates.
      const horizon = awstDateFromUtc(new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000))

      // Every role but contractor-admin needs the date to be open, so keep that
      // as a DB filter; the closure/capacity tiers are then applied by
      // isIdDateBookable, which mirrors the RPC exactly. Lock-closed dates now
      // reach the filter (rather than being excluded here) so office and
      // council staff can be offered the 3-day window.
      let dateQuery = supabase
        .from('collection_date')
        .select(
          'id, date, id_capacity_limit, id_units_booked, collection_area_id, is_open, id_is_closed, locked_closed',
        )
        .in('collection_area_id', areas.map((a) => a.id))
        .gte('date', today)
        .lte('date', horizon)
        .order('date', { ascending: true })
        .limit(500)
      if (!isContractorAdmin) {
        dateQuery = dateQuery.eq('is_open', true)
      }
      const { data: dateRows } = await dateQuery
      dates = dateRows ?? []

      // Pool-backed areas (capacity_pool_id set) keep their ID counters on
      // collection_date_pool, not collection_date — the per-date numbers never
      // move for them. Swap in the pool counts and drop pool-closed dates so
      // the picker matches what the RPC will enforce.
      const poolByArea = new Map(
        (areaRows ?? [])
          .filter((a) => a.capacity_pool_id)
          .map((a) => [a.id, a.capacity_pool_id as string])
      )
      // Unpooled areas gate on their own row. Pooled areas MUST NOT — a pool
      // member carries id_capacity_limit = 0 on its own row (the real limit
      // lives on the pool), so judging them here would hide every pooled date.
      // They are gated on the pool's counters just below instead.
      dates = dates.filter(
        (d) => poolByArea.has(d.collection_area_id) || isIdDateBookable(d, access),
      )

      if (poolByArea.size > 0 && dates.length > 0) {
        const poolIds = [...new Set(poolByArea.values())]
        const { data: poolRows } = await supabase
          .from('collection_date_pool')
          .select('capacity_pool_id, date, id_capacity_limit, id_units_booked, id_is_closed, locked_closed')
          .in('capacity_pool_id', poolIds)
          .gte('date', today)
          .lte('date', horizon)
        const poolByKey = new Map(
          (poolRows ?? []).map((r) => [`${r.capacity_pool_id}|${r.date}`, r])
        )
        dates = dates.flatMap((d) => {
          const poolId = poolByArea.get(d.collection_area_id)
          if (!poolId) return [d]
          const pool = poolByKey.get(`${poolId}|${d.date}`)
          if (!pool) return []
          // Gate pooled dates on the POOL's counters + lock (what the RPC
          // enforces), but on the AREA's own is_open — that's where a holiday
          // or admin closure lands for a pool member.
          const bookable = isIdDateBookable(
            {
              is_open: d.is_open,
              id_is_closed: pool.id_is_closed,
              locked_closed: pool.locked_closed,
              id_capacity_limit: pool.id_capacity_limit,
              id_units_booked: pool.id_units_booked,
            },
            access,
          )
          if (!bookable) return []
          return [
            {
              ...d,
              id_capacity_limit: pool.id_capacity_limit,
              id_units_booked: pool.id_units_booked,
            },
          ]
        })
      }
    }
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <div>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Link href="/admin/illegal-dumping" className="hover:text-[#293F52] hover:underline">
              Illegal Dumping
            </Link>
            <span>/</span>
            <span>New</span>
          </div>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            New ID Collection
          </h1>
          <p className="mt-0.5 text-body-sm text-gray-500">
            Log a reported illegal dumping pile and schedule its collection.
          </p>
        </div>
      </div>

      <div className="flex-1 px-7 py-6">
        {currentClient ? (
          <IdRequestForm areas={areas} dates={dates} isContractorAdmin={isContractorAdmin} />
        ) : (
          <div className="mx-auto mt-10 w-full max-w-xl rounded-xl bg-white px-8 py-10 text-center shadow-sm">
            <p className="text-body-sm text-gray-500">
              Select a client in the sidebar switcher to log an ID collection.
            </p>
          </div>
        )}
      </div>
    </>
  )
}
