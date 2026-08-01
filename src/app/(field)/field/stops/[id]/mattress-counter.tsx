'use client'

import { MATTRESS_COUNT_MAX } from '@/lib/stops/mattress'

/**
 * Mattress count entry at bulk-stop closeout (#487) — rendered on the main
 * closeout screen AND inside the NCN/NP forms (the count is required on every
 * closeout path, like MUD counts; 0 must be a one-tap answer, which is why
 * it defaults to 0 rather than being a skippable blank). Same counter UX as
 * the MUD allocation form, sized down to a single row.
 */
export function MattressCounter({
  count,
  onChange,
}: {
  count: number
  onChange: (next: number) => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Mattresses Collected
        </div>
        <div className="text-[10px] text-gray-400">Required — 0 if none</div>
      </div>
      <div className="flex items-center justify-center gap-5 py-1.5">
        <button
          type="button"
          aria-label="Fewer mattresses"
          onClick={() => onChange(Math.max(0, count - 1))}
          className="flex size-[48px] items-center justify-center rounded-full border-2 border-gray-100 bg-white text-[26px] font-bold text-[var(--brand)] shadow-sm"
        >
          &minus;
        </button>
        <span className="w-12 text-center font-[family-name:var(--font-heading)] text-[32px] font-bold text-[var(--brand)]">
          {count}
        </span>
        <button
          type="button"
          aria-label="More mattresses"
          onClick={() => onChange(Math.min(MATTRESS_COUNT_MAX, count + 1))}
          className="flex size-[48px] items-center justify-center rounded-full border-2 border-[var(--brand)] bg-[var(--brand)] text-[26px] font-bold text-[var(--brand-accent)] shadow-[0_4px_12px_rgba(41,63,82,0.3)]"
        >
          +
        </button>
      </div>
    </div>
  )
}
