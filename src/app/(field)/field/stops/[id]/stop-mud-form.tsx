'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { STREAM_LABEL } from '@/lib/stops/labels'
import { saveMudActualServices } from '../../booking/[ref]/actions'
import type { StopDetail } from './stop-closeout-client'

interface StopMudItem {
  id: string
  no_services: number
  actual_services: number | null
  service: { name: string }
}

interface StopMudFormProps {
  stop: StopDetail
  /** Pre-filtered to THIS stop's stream — the other pass enters its own. */
  items: StopMudItem[]
  /** Where to land after saving — preserves a requested ?action=ncn/np. */
  returnTo: string
}

/**
 * Per-stream MUD allocation entry. Same counter UX as the legacy
 * per-booking form, but scoped to the stop's stream: the general crew
 * enters general counts, the green crew enters green counts.
 * Persists via the same `bulk_update_booking_item_actuals` RPC.
 */
export function StopMudForm({ stop, items, returnTo }: StopMudFormProps) {
  const router = useRouter()
  const [counts, setCounts] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {}
    for (const i of items) {
      initial[i.id] = i.actual_services ?? 0
    }
    return initial
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function bump(itemId: string, delta: number) {
    setCounts((prev) => ({
      ...prev,
      [itemId]: Math.max(0, (prev[itemId] ?? 0) + delta),
    }))
  }

  async function handleSubmit() {
    setIsSubmitting(true)
    setError(null)

    try {
      const result = await saveMudActualServices(
        stop.booking.id,
        items.map((i) => ({
          booking_item_id: i.id,
          actual_count: counts[i.id] ?? 0,
        }))
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      // With this stream's counts saved the early-return into this form
      // falls through — back to the close-out screen, or straight into the
      // NCN/NP form the crew originally asked for.
      router.replace(returnTo)
      router.refresh()
    } catch {
      setError('No connection — check signal and retry.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      {/* Header */}
      <div className="shrink-0 border-b border-gray-100 bg-white px-5 py-4">
        <Link
          href={`/field/stops/${stop.id}`}
          className="mb-2.5 flex items-center gap-1.5 text-[13px] font-medium text-[#8FA5B8]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {stop.booking.ref}
        </Link>
        <div>
          <div className="font-[family-name:var(--font-heading)] text-base font-bold text-[var(--brand)]">
            {stop.booking.ref}{' '}
            <span className="text-xs font-normal text-gray-500">
              &middot; MUD &middot; {STREAM_LABEL[stop.stream]}
            </span>
          </div>
          <div className="mt-0.5 text-[13px] text-gray-500">{stop.address ?? ''}</div>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pb-24 pt-4">
        {/* Info banner */}
        <div className="rounded-[10px] border border-[#FF8C42] bg-[#FFF3EA] px-3.5 py-3">
          <div className="mb-1 text-[13px] font-semibold text-[#8B4000]">
            MUD Collection — {STREAM_LABEL[stop.stream]} Allocation Entry
          </div>
          <div className="text-xs text-[#8B4000]">
            Enter the actual count collected for each {STREAM_LABEL[stop.stream].toLowerCase()} service.
            Required for all close-out paths (Complete, NCN, Nothing Presented).
            Enter 0 if nothing was collected.
          </div>
        </div>

        {/* One counter per stream item */}
        {items.map((item) => {
          const count = counts[item.id] ?? 0
          return (
            <div
              key={item.id}
              className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  {item.service.name}
                </div>
                <div className="text-[10px] text-gray-400">
                  Pre-booked: {item.no_services}
                </div>
              </div>

              <div className="flex flex-col items-center gap-4 py-4">
                <div className="flex size-[88px] items-center justify-center rounded-full bg-[var(--brand)] shadow-[0_8px_24px_rgba(41,63,82,0.3)]">
                  <span className="font-[family-name:var(--font-heading)] text-[36px] font-bold text-[var(--brand-accent)]">
                    {count}
                  </span>
                </div>
                <div className="flex items-center gap-5">
                  <button
                    type="button"
                    onClick={() => bump(item.id, -1)}
                    className="flex size-[48px] items-center justify-center rounded-full border-2 border-gray-100 bg-white text-[26px] font-bold text-[var(--brand)] shadow-sm"
                  >
                    &minus;
                  </button>
                  <span className="text-[12px] text-gray-500">collected</span>
                  <button
                    type="button"
                    onClick={() => bump(item.id, 1)}
                    className="flex size-[48px] items-center justify-center rounded-full border-2 border-[var(--brand)] bg-[var(--brand)] text-[26px] font-bold text-[var(--brand-accent)] shadow-[0_4px_12px_rgba(41,63,82,0.3)]"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          )
        })}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="flex w-full items-center justify-center rounded-xl bg-[var(--brand-accent)] px-3.5 py-3.5 text-sm font-semibold text-[var(--brand)] disabled:opacity-50"
        >
          {isSubmitting ? 'Saving...' : 'Save Counts & Continue'}
        </button>
      </div>
    </>
  )
}
