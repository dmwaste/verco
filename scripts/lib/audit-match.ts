// scripts/lib/audit-match.ts
//
// Pure matching for the "Airtable booking not imported into Verco" audit.
//
// Two bridges, matching the reconcile tooling:
//   - VV (MOS/COT/PEP): property (Airtable Eligible Properties recId ==
//     Verco eligible_properties.external_id) + collection date, with a
//     tolerance window so a booking rescheduled IN VERCO (Verco is the source
//     of truth since 01/07) still counts as "imported", not missing.
//   - KWN: exact booking ref (Verco booking.ref == Airtable Booking_Ref). Ref
//     is stable across reschedules, so a plain set difference is correct.
//
// No I/O here — the entrypoint fetches both sides and passes plain objects in.

export type PropDatedRow = { propertyKey: string; date: string }

function daysApart(a: string, b: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y!, m! - 1, d!)
  }
  return Math.abs(t(a) - t(b)) / 86_400_000
}

/**
 * Return the subset of `sources` that have NO Verco booking at the same
 * property within `toleranceDays` of the source's date. Verco dates are
 * consumed on match, so a property with two source bookings but one Verco
 * booking yields exactly one "missing".
 *
 * `vercoDatesByProperty` maps a Verco property external id → the collection
 * dates of every Verco booking at that property (any status — a cancelled
 * Verco row still means the booking was imported).
 */
export function findMissingByPropertyDate<T extends PropDatedRow>(
  vercoDatesByProperty: Map<string, string[]>,
  sources: T[],
  toleranceDays: number,
): T[] {
  // Clone so we can consume dates without mutating the caller's map.
  const remaining = new Map<string, string[]>()
  for (const [k, v] of vercoDatesByProperty) remaining.set(k, [...v])

  const missing: T[] = []
  // Exact-date matches first, so a nearby booking can't steal an exact partner.
  const ordered = [...sources].sort((a, b) => a.date.localeCompare(b.date))

  for (const s of ordered) {
    const dates = remaining.get(s.propertyKey)
    if (!dates || dates.length === 0) {
      missing.push(s)
      continue
    }
    // Prefer an exact date; otherwise the closest within tolerance.
    let bestIdx = -1
    let bestDist = Infinity
    for (let i = 0; i < dates.length; i++) {
      const dist = daysApart(dates[i]!, s.date)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = i
      }
      if (dist === 0) break
    }
    if (bestIdx >= 0 && bestDist <= toleranceDays) {
      dates.splice(bestIdx, 1) // consume
    } else {
      missing.push(s)
    }
  }
  return missing
}

/**
 * Return the subset of `sourceRefs` rows whose ref is absent from `vercoRefs`.
 * Used for KWN, where the Verco ref equals the Airtable Booking_Ref.
 */
export function findMissingByRef<T extends { ref: string }>(vercoRefs: Set<string>, sources: T[]): T[] {
  return sources.filter((s) => !vercoRefs.has(s.ref))
}
