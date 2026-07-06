'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { SkeletonRow } from '@/components/ui/skeleton'
import { SurveySummary } from './survey-summary'

const PAGE_SIZE = 20

const RATING_OPTIONS = ['5', '4', '3', '2', '1']

/** Defensive 1..5 integer extraction from the opaque responses jsonb blob. */
function extractRating(responses: unknown, key: string): number | null {
  if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) {
    return null
  }
  const raw = (responses as Record<string, unknown>)[key]
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
}

function MiniStars({ value }: { value: number | null }) {
  if (value === null) return <span className="text-gray-300">—</span>
  return (
    <span className="inline-flex gap-0.5" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <svg key={s} width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
            fill={s <= value ? '#FF8C42' : '#E8E8E8'}
          />
        </svg>
      ))}
    </span>
  )
}

interface SurveyRow {
  id: string
  submitted_at: string | null
  responses: unknown
  created_at: string
  booking: {
    ref: string
    collection_area: { code: string } | null
    eligible_properties: { formatted_address: string | null } | null
  } | null
}

interface SurveysListClientProps {
  /** Selected tenant from the admin switcher — scopes every query. */
  clientId: string
}

export function SurveysListClient({ clientId }: SurveysListClientProps) {
  const searchParams = useSearchParams()
  const supabase = createClient()

  const [search, setSearch] = useState(searchParams.get('search') ?? '')
  const [areaFilter, setAreaFilter] = useState(searchParams.get('area') ?? '')
  const [ratingFilter, setRatingFilter] = useState(searchParams.get('rating') ?? '')
  const [page, setPage] = useState(0)

  // Sync URL → state on soft-navigation (CLAUDE.md §21 searchParams gotcha).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional URL→state sync on soft-navigation
    setSearch(searchParams.get('search') ?? '')
    setAreaFilter(searchParams.get('area') ?? '')
    setRatingFilter(searchParams.get('rating') ?? '')
    setPage(0)
  }, [searchParams])

  // Areas for the filter dropdown — collection_area is public-SELECT, so scope
  // explicitly to the selected client.
  const { data: areas } = useQuery({
    queryKey: ['collection-areas', clientId],
    queryFn: async () => {
      let q = supabase.from('collection_area').select('id, code').eq('is_active', true).order('code')
      if (clientId) q = q.eq('client_id', clientId)
      const { data } = await q
      return data ?? []
    },
  })

  const { data: surveysData, isLoading } = useQuery({
    queryKey: ['admin-surveys', clientId, search, areaFilter, ratingFilter, page],
    queryFn: async () => {
      // Ref/address search → pre-fetch matching booking ids (scoped to client),
      // then filter surveys by booking_id. Avoids fragile .or() on an embedded
      // resource (CLAUDE.md §21).
      let matchingBookingIds: string[] | null = null
      if (search) {
        const propMatches = await supabase
          .from('eligible_properties')
          .select('id')
          .ilike('formatted_address', `%${search}%`)
          .limit(500)
        const propIds = propMatches.data?.map((r) => r.id) ?? []
        const orClauses = [`ref.ilike.%${search}%`]
        if (propIds.length > 0) orClauses.push(`property_id.in.(${propIds.join(',')})`)
        let bq = supabase.from('booking').select('id')
        if (clientId) bq = bq.eq('client_id', clientId)
        const bookingMatches = await bq.or(orClauses.join(',')).limit(1000)
        matchingBookingIds = bookingMatches.data?.map((r) => r.id) ?? []
      }

      let query = supabase
        .from('booking_survey')
        .select(
          `id, submitted_at, responses, created_at,
           booking!inner(ref, collection_area!inner(code), eligible_properties:property_id(formatted_address))`,
          { count: 'exact' }
        )
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      if (clientId) query = query.eq('client_id', clientId)
      // Surveys list shows submitted surveys only.
      query = query.not('submitted_at', 'is', null)
      if (areaFilter) query = query.eq('booking.collection_area_id', areaFilter)
      if (matchingBookingIds) {
        query = query.in('booking_id', matchingBookingIds.length ? matchingBookingIds : ['00000000-0000-0000-0000-000000000000'])
      }

      const { data, count } = await query
      return { surveys: (data ?? []) as unknown as SurveyRow[], total: count ?? 0 }
    },
  })

  const allRows = surveysData?.surveys ?? []
  // Rating filter is client-side: jsonb numeric compares lexically in Postgres
  // ('10' < '4'), so we never push it into the query (CLAUDE.md §21).
  const rows = ratingFilter
    ? allRows.filter((r) => extractRating(r.responses, 'overall_rating') === Number(ratingFilter))
    : allRows
  const total = surveysData?.total ?? 0

  return (
    <>
      <PageHeader title="Surveys" subtitle={`${total} survey${total === 1 ? '' : 's'}`}>
        {/* Route handler returns a CSV download (not a page), so a plain anchor
            with `download` is correct here, not a next/link. */}
        <a
          href="/admin/surveys/export"
          download
          className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-1.5 text-body-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export CSV
        </a>
      </PageHeader>

      <SurveySummary clientId={clientId} />

      <FilterBar>
        <SearchInput
          value={search}
          onChange={(value) => { setSearch(value); setPage(0) }}
          placeholder="Search ref, address..."
          ariaLabel="Search surveys"
        />
        <FilterSelect
          value={areaFilter}
          onChange={(e) => { setAreaFilter(e.target.value); setPage(0) }}
          aria-label="Filter by area"
        >
          <option value="">All Areas</option>
          {(areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>{a.code}</option>
          ))}
        </FilterSelect>
        <FilterSelect
          value={ratingFilter}
          onChange={(e) => { setRatingFilter(e.target.value); setPage(0) }}
          aria-label="Filter by overall rating"
        >
          <option value="">All Ratings</option>
          {RATING_OPTIONS.map((r) => (
            <option key={r} value={r}>{r} stars</option>
          ))}
        </FilterSelect>
      </FilterBar>

      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                <Th>Ref</Th>
                <Th>Area</Th>
                <Th>Submitted</Th>
                <Th>Booking</Th>
                <Th>Collection</Th>
                <Th>Overall</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} columns={6} />)}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">No surveys found</td></tr>
              )}
              {rows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/surveys/${row.id}`}
                        className="font-[family-name:var(--font-heading)] text-body-sm font-semibold text-[#293F52] hover:underline"
                      >
                        {row.booking?.ref ?? '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {row.booking?.collection_area?.code ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-body-sm text-gray-900">
                      {row.submitted_at ? format(new Date(row.submitted_at), 'd MMM yyyy') : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <MiniStars value={extractRating(row.responses, 'booking_rating')} />
                    </td>
                    <td className="px-4 py-3">
                      <MiniStars value={extractRating(row.responses, 'collection_rating')} />
                    </td>
                    <td className="px-4 py-3">
                      <MiniStars value={extractRating(row.responses, 'overall_rating')} />
                    </td>
                  </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </div>
    </>
  )
}
