'use client'

import { cn } from '@/lib/utils'

/** Standard admin filter row under the page header. */
export function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 px-7 py-4">
      {children}
    </div>
  )
}

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
}

/** Search box for admin filter bars, with a visible focus affordance. */
export function SearchInput({ value, onChange, placeholder, ariaLabel }: SearchInputProps) {
  return (
    <div className="flex w-60 items-center gap-2 rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] focus-within:border-[#293F52]">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full border-none bg-transparent text-body-sm text-gray-900 outline-none placeholder:text-gray-300"
      />
    </div>
  )
}

/** Select for admin filter bars — plain <select> pass-through with the shared style. */
export function FilterSelect({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700',
        className
      )}
    />
  )
}

interface DateRangeFilterProps {
  from: string
  to: string
  /** Both bounds are reported on every change; either may be an empty string. */
  onChange: (from: string, to: string) => void
  /** Short leading label so the bare date inputs read unambiguously. */
  label?: string
  /** Base for the two inputs' aria-labels, e.g. "Collection date" → "… from/to". */
  ariaPrefix: string
}

const DATE_INPUT_CLASS =
  'rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700 focus:border-[#293F52] focus:outline-none'

/**
 * From/To date-range filter using native date inputs (calendar popovers). Shows
 * a clear button once either bound is set. The two inputs constrain each other
 * (`from`'s max is `to`, `to`'s min is `from`) so an invalid range can't be picked.
 */
export function DateRangeFilter({ from, to, onChange, label, ariaPrefix }: DateRangeFilterProps) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-caption font-medium text-gray-500">{label}</span>}
      <input
        type="date"
        value={from}
        max={to || undefined}
        onChange={(e) => onChange(e.target.value, to)}
        aria-label={`${ariaPrefix} from`}
        className={DATE_INPUT_CLASS}
      />
      <span className="text-body-sm text-gray-400">–</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={(e) => onChange(from, e.target.value)}
        aria-label={`${ariaPrefix} to`}
        className={DATE_INPUT_CLASS}
      />
      {(from || to) && (
        <button
          type="button"
          onClick={() => onChange('', '')}
          aria-label={`Clear ${ariaPrefix.toLowerCase()} filter`}
          className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      )}
    </div>
  )
}
