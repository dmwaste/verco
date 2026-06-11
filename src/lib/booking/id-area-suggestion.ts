import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'
import {
  addressMatchKey,
  buildAddressIlikePattern,
  buildEligibleOrFilter,
  buildLookupCandidates,
} from './address-match-key'
import { stripAddressPrefix } from '@/lib/mud/address-strip'

// Soft address↔area consistency for the admin ID request form (red-team
// follow-up from PR #164). Office staff pick an address and a collection area
// independently — when the address resolves to an eligible property we can
// suggest its area, or warn when it disagrees with the staff member's pick.
// ID locations may legitimately be non-property spots (parks, verges), so a
// failed match means "no opinion", never an error, and a mismatch is a
// warning, never a block.

export type AreaSuggestion =
  | { kind: 'none' }
  | { kind: 'suggest'; areaId: string }
  | { kind: 'agree'; areaId: string }
  | { kind: 'mismatch'; matchedAreaId: string; selectedAreaId: string }

/**
 * Pure verdict: how the matched property's area relates to the user's
 * current selection.
 *
 * - no match, or a match outside the offered area list (inactive area,
 *   different sub-client, stale data) → 'none' — nothing useful to say
 * - match + no selection yet → 'suggest' (caller may auto-select)
 * - match equals selection → 'agree'
 * - match differs from selection → 'mismatch' (soft warning)
 */
export function resolveAreaSuggestion(
  matchedAreaId: string | null,
  selectedAreaId: string,
  offeredAreaIds: readonly string[]
): AreaSuggestion {
  if (!matchedAreaId || !offeredAreaIds.includes(matchedAreaId)) {
    return { kind: 'none' }
  }
  if (!selectedAreaId) {
    return { kind: 'suggest', areaId: matchedAreaId }
  }
  if (selectedAreaId === matchedAreaId) {
    return { kind: 'agree', areaId: matchedAreaId }
  }
  return { kind: 'mismatch', matchedAreaId, selectedAreaId }
}

/**
 * Resolves an address to a collection area via eligible_properties, using the
 * same multi-pass machinery as the public booking flow: google_place_id first,
 * then ILIKE candidates (raw → premise-stripped → street-type-normalised →
 * both). Scoped to `areaIds` (the client's — and, where narrowed, the
 * sub-client's — areas from the page), which also tenant-scopes the
 * public-SELECT table (CLAUDE.md §21).
 *
 * Only an UNAMBIGUOUS match counts: a candidate that ILIKE-matches two or
 * more properties is skipped rather than guessed at.
 */
export async function matchAddressToArea(
  supabase: SupabaseClient<Database>,
  opts: { placeId: string | null; address: string; areaIds: readonly string[] }
): Promise<string | null> {
  if (opts.areaIds.length === 0) return null

  const tryLookup = async (s: string, pid?: string): Promise<string | null> => {
    if (pid) {
      const { data } = await supabase
        .from('eligible_properties')
        .select('collection_area_id')
        .eq('google_place_id', pid)
        .in('collection_area_id', opts.areaIds as string[])
        .maybeSingle()
      if (data?.collection_area_id) return data.collection_area_id
    }

    const key = addressMatchKey(s)
    if (!key) return null

    const fmtPattern = buildAddressIlikePattern(key)
    const streetSegment = s.split(',')[0]?.trim() ?? s
    const addrPattern = buildAddressIlikePattern(addressMatchKey(streetSegment))
    const { data } = await supabase
      .from('eligible_properties')
      .select('collection_area_id')
      .or(buildEligibleOrFilter(fmtPattern, addrPattern))
      .in('collection_area_id', opts.areaIds as string[])
      .limit(2)
    if (data && data.length === 1) return data[0]?.collection_area_id ?? null
    return null
  }

  const candidates = buildLookupCandidates(opts.address, stripAddressPrefix)
  for (const candidate of candidates) {
    const areaId = await tryLookup(
      candidate,
      candidate === opts.address ? (opts.placeId ?? undefined) : undefined
    )
    if (areaId) return areaId
  }
  return null
}
