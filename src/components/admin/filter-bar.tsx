'use client'

import { Menu } from '@base-ui/react/menu'
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

export interface MultiSelectOption {
  value: string
  label: string
}

export interface MultiSelectGroup {
  label: string
  options: MultiSelectOption[]
}

interface MultiSelectFilterProps {
  /** Trigger text when nothing is ticked (no filter), e.g. "All Statuses". */
  allLabel: string
  /** Plural noun for a multi-pick summary: "statuses" → "3 statuses". */
  pluralNoun: string
  /** Flat option list. Ignored when `groups` is set. */
  options?: MultiSelectOption[]
  /** Two-level list (e.g. areas by council); each group header ticks its whole group. */
  groups?: MultiSelectGroup[] | null
  selected: string[]
  onChange: (next: string[]) => void
  ariaLabel: string
}

const MENU_ITEM_CLASS =
  'flex w-full cursor-pointer items-center gap-2 px-3.5 py-1.5 text-left text-body-sm text-gray-700 outline-none data-[highlighted]:bg-gray-50'

function CheckMark({ state }: { state: 'on' | 'off' | 'mixed' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded border-[1.5px]',
        state === 'off' ? 'border-gray-300 bg-white' : 'border-[#293F52] bg-[#293F52]'
      )}
    >
      {state === 'on' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      )}
      {state === 'mixed' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
      )}
    </span>
  )
}

/**
 * Multi-select for admin filter bars. Empty selection = no filter (the
 * "All …" state), one tick behaves like the old single select, more ticks OR
 * together. The menu stays open while ticking; Escape or an outside click
 * closes it. Portalled (Base UI), so table cards never clip it.
 */
export function MultiSelectFilter({
  allLabel,
  pluralNoun,
  options = [],
  groups,
  selected,
  onChange,
  ariaLabel,
}: MultiSelectFilterProps) {
  const allOptions = groups ? groups.flatMap((g) => g.options) : options
  const chosen = new Set(selected)

  // Keep the selection in option order so the URL and query keys are stable;
  // ids not (yet) in the option list are kept, not silently dropped.
  const commit = (next: Set<string>) => {
    const known = allOptions.map((o) => o.value)
    onChange([...known.filter((v) => next.has(v)), ...[...next].filter((v) => !known.includes(v))])
  }
  const setValues = (values: string[], on: boolean) => {
    const next = new Set(chosen)
    for (const v of values) {
      if (on) next.add(v)
      else next.delete(v)
    }
    commit(next)
  }

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (allOptions.find((o) => o.value === selected[0])?.label ?? `1 ${pluralNoun}`)
        : `${selected.length} ${pluralNoun}`

  const renderOption = (o: MultiSelectOption, indent: boolean) => (
    <Menu.CheckboxItem
      key={o.value}
      checked={chosen.has(o.value)}
      onCheckedChange={(on) => setValues([o.value], on)}
      className={cn(MENU_ITEM_CLASS, indent && 'pl-8')}
    >
      <CheckMark state={chosen.has(o.value) ? 'on' : 'off'} />
      {o.label}
    </Menu.CheckboxItem>
  )

  return (
    <Menu.Root>
      <Menu.Trigger
        // Name carries the current value, as a native <select> announces it
        // (label-in-name: "Filter by status: 3 statuses").
        aria-label={`${ariaLabel}: ${summary}`}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border-[1.5px] bg-white px-3 py-[7px] text-body-sm',
          selected.length > 0 ? 'border-[#293F52] font-medium text-gray-900' : 'border-gray-100 text-gray-700'
        )}
      >
        {summary}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="opacity-60"><polyline points="6 9 12 15 18 9"/></svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className="max-h-80 min-w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg outline-none">
            {/* Always rendered (disabled when empty) so the first tick doesn't
                shift every option down under the cursor. */}
            <div className="mb-1 border-b border-gray-100 pb-1">
              <Menu.Item
                disabled={selected.length === 0}
                onClick={() => onChange([])}
                className={cn(MENU_ITEM_CLASS, 'font-medium text-[#293F52] data-[disabled]:cursor-default data-[disabled]:text-gray-300')}
              >
                Clear selection
              </Menu.Item>
            </div>
            {groups
              ? groups.map((g) => {
                  const values = g.options.map((o) => o.value)
                  const ticked = values.filter((v) => chosen.has(v)).length
                  const state = ticked === 0 ? 'off' : ticked === values.length ? 'on' : 'mixed'
                  return (
                    <Menu.Group key={g.label}>
                      <Menu.CheckboxItem
                        checked={state === 'on'}
                        onCheckedChange={() => setValues(values, state !== 'on')}
                        className={cn(MENU_ITEM_CLASS, 'font-semibold text-gray-900')}
                      >
                        <CheckMark state={state} />
                        {g.label}
                      </Menu.CheckboxItem>
                      {g.options.map((o) => renderOption(o, true))}
                    </Menu.Group>
                  )
                })
              : allOptions.map((o) => renderOption(o, false))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
