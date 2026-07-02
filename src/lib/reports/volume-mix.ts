import type { WasteStream } from '@/lib/stops/stops'

/**
 * VOLMIX — Volume & Mix insight card (VER-179, spec §3.8).
 *
 * Pure + deterministic: no Supabase, no network, no wall-clock reads. It folds
 * flat `booking_item` rows (already RLS-scoped + area-filtered by the caller)
 * into total collections, a per-waste-stream breakdown, a per-service
 * breakdown, and a free/extra split. No pass/fail — directional only.
 *
 * Quantity per row = `actual_services ?? no_services` (mirrors
 * `nightly-sync-to-dm-ops`): once a crew confirms actuals at closeout the
 * confirmed count wins; until then the booked count stands. `?? ` (not `||`) is
 * deliberate — a confirmed `actual_services = 0` must override a booked
 * `no_services`, whereas `0 || x` would fall through to the booked value.
 *
 * Defensive on the volume input (null / NaN / negative are coerced to 0) so a
 * single bad row can never poison the totals with NaN.
 */

export interface VolumeMixRow {
  no_services: number
  actual_services: number | null
  is_extra: boolean
  waste_stream: WasteStream
  service_name: string
}

export interface VolumeMixServiceEntry {
  name: string
  qty: number
}

export interface VolumeMixResult {
  totalCollections: number
  /** Keyed by the streams that actually appear — absent streams are omitted. */
  byStream: Partial<Record<WasteStream, number>>
  /** Per-service totals, sorted by qty descending. */
  byService: VolumeMixServiceEntry[]
  freeUnits: number
  extraUnits: number
  isEmpty: boolean
  isLowN: boolean
}

/**
 * Below this many total collections the card suppresses its share bars and
 * shows a "Building data" label instead (spec §3.8 / §5.4). Exported so it is
 * testable + tunable.
 */
export const VOLUME_MIX_LOW_N = 20

/** Coerce a raw quantity to a safe, non-negative finite number. */
function safeVolume(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0
  return value > 0 ? value : 0
}

export function computeVolumeMix(rows: VolumeMixRow[]): VolumeMixResult {
  const byStream: Partial<Record<WasteStream, number>> = {}
  const byServiceMap = new Map<string, number>()
  let totalCollections = 0
  let freeUnits = 0
  let extraUnits = 0

  for (const r of rows) {
    const volume = safeVolume(r.actual_services ?? r.no_services)
    if (volume === 0) continue

    totalCollections += volume
    byStream[r.waste_stream] = (byStream[r.waste_stream] ?? 0) + volume
    byServiceMap.set(r.service_name, (byServiceMap.get(r.service_name) ?? 0) + volume)

    if (r.is_extra) {
      extraUnits += volume
    } else {
      freeUnits += volume
    }
  }

  const byService = [...byServiceMap.entries()]
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)

  return {
    totalCollections,
    byStream,
    byService,
    freeUnits,
    extraUnits,
    isEmpty: totalCollections === 0,
    isLowN: totalCollections > 0 && totalCollections < VOLUME_MIX_LOW_N,
  }
}
