'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { buildSearchOrFilter } from '@/lib/search/or-filter'

interface PropertyResult {
  id: string
  address: string
  formatted_address: string | null
  is_mud: boolean
}

interface LookupClientProps {
  /** Pre-fetched server-side from the ranger's user_roles scope —
   *  eligible_properties is public-SELECT, so this filter IS the tenant
   *  boundary. Never widen it client-side. */
  areaIds: string[]
  clientName: string
}

export function LookupClient({ areaIds, clientName }: LookupClientProps) {
  const supabase = createClient()
  const [term, setTerm] = useState('')
  const [debouncedTerm, setDebouncedTerm] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedTerm(term.trim()), 300)
    return () => clearTimeout(t)
  }, [term])

  const enabled = debouncedTerm.length >= 3 && areaIds.length > 0

  const { data: results, isFetching } = useQuery({
    queryKey: ['ranger-lookup', debouncedTerm],
    enabled,
    queryFn: async (): Promise<PropertyResult[]> => {
      const { data, error } = await supabase
        .from('eligible_properties')
        .select('id, address, formatted_address, is_mud')
        .in('collection_area_id', areaIds)
        .or(buildSearchOrFilter(['address', 'formatted_address'], debouncedTerm))
        .order('address')
        .limit(25)
      if (error) throw new Error(error.message)
      return data ?? []
    },
  })

  return (
    <div className="flex flex-col gap-3 px-5 pt-4">
      <div>
        <h1 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
          Address Lookup
        </h1>
        <p className="mt-0.5 text-body-sm text-gray-500">
          Check whether a pile belongs to a booking — {clientName}
        </p>
      </div>

      {/* Search box */}
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8FA5B8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="search"
          inputMode="search"
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Start typing a street address..."
          className="w-full rounded-xl border-[1.5px] border-gray-100 bg-white py-3 pl-10 pr-3.5 text-sm text-gray-900 shadow-sm outline-none placeholder:text-gray-400 focus:border-[var(--brand)]"
        />
      </div>

      {areaIds.length === 0 && (
        <div className="rounded-lg bg-[#FFF3EA] px-3.5 py-2.5 text-xs text-[#8B4000]">
          No collection areas are assigned to your account — contact your administrator.
        </div>
      )}

      {/* Results */}
      {enabled && (
        <div className="flex flex-col gap-2">
          {isFetching && (
            <div className="rounded-xl bg-white p-4 text-center text-xs text-gray-500 shadow-sm">
              Searching…
            </div>
          )}
          {!isFetching && results && results.length === 0 && (
            <div className="rounded-xl bg-white p-4 text-center shadow-sm">
              <div className="text-sm font-semibold text-[var(--brand)]">No matches</div>
              <div className="mt-0.5 text-xs text-gray-500">
                Address not eligible for verge collection — likely a candidate for an ID.
              </div>
            </div>
          )}
          {(results ?? []).map((p) => (
            <Link
              key={p.id}
              href={`/field/lookup/${p.id}`}
              className="flex items-center justify-between gap-2 rounded-xl bg-white p-3.5 shadow-sm active:bg-gray-50"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--brand)]">
                  {(p.formatted_address ?? p.address).split(',')[0]}
                </div>
                <div className="truncate text-xs text-gray-500">
                  {(p.formatted_address ?? p.address).split(',').slice(1).join(',').trim()}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {p.is_mud && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-semibold text-gray-700">
                    MUD
                  </span>
                )}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8FA5B8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </div>
            </Link>
          ))}
        </div>
      )}

      {!enabled && term.trim().length > 0 && term.trim().length < 3 && (
        <div className="text-center text-xs text-gray-400">Keep typing — 3+ characters</div>
      )}
    </div>
  )
}
