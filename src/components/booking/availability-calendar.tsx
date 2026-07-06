'use client'

import { useState } from 'react'
import { format, isSameMonth, isToday } from 'date-fns'
import { cn } from '@/lib/utils'
import {
  monthGrid,
  uniqueMonths,
  STATUS_CHIP,
  WEEKDAY_LABELS,
  type DateStatus,
} from '@/lib/booking/calendar'

export interface CalendarDate {
  id: string
  date: Date
  status: DateStatus
}

/**
 * Month calendar for picking a collection date. Available days are colour-coded
 * cells (green = available, amber = low); non-collection days are inert. Month
 * navigation hops only between months that actually contain dates, so a resident
 * never pages through empty months. The selected date's full status pill is
 * rendered by the caller beneath the calendar.
 *
 * Shared by the resident booking wizard (`/book/date`) and the admin illegal
 * dumping intake (`/admin/illegal-dumping/new`). Presentational only — the
 * caller decides which dates are bookable and maps each to a DateStatus.
 */
export function AvailabilityCalendar({
  dates,
  selectedId,
  onSelect,
}: {
  dates: CalendarDate[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const months = uniqueMonths(dates.map((d) => d.date))
  const byDay = new Map(dates.map((d) => [format(d.date, 'yyyy-MM-dd'), d]))

  // Open on the selected date's month if one is set, otherwise the earliest.
  const selectedDate = dates.find((d) => d.id === selectedId)?.date
  const initialIndex =
    selectedDate != null
      ? Math.max(
          0,
          months.findIndex((m) => isSameMonth(m, selectedDate))
        )
      : 0
  const [monthIndex, setMonthIndex] = useState(initialIndex)

  if (months.length === 0) return null

  const safeIndex = Math.min(monthIndex, months.length - 1)
  const viewMonth = months[safeIndex]!
  const grid = monthGrid(viewMonth)

  return (
    <div className="mx-auto max-w-sm rounded-xl bg-white p-4 shadow-sm">
      {/* Legend */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[var(--brand-accent)]" />
          Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#E2A23B]" />
          Low availability
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-[var(--brand)]" />
          Today
        </span>
        {/* Only shown in the edit flow, where a held date is pinned as `current`. */}
        {dates.some((d) => d.status === 'current') && (
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full border border-[var(--brand)] bg-[#E8EEF2]" />
            Current date
          </span>
        )}
      </div>

      {/* Month navigation — clamped to months that contain dates */}
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonthIndex((i) => Math.max(0, i - 1))}
          disabled={safeIndex === 0}
          aria-label="Previous month"
          className="flex size-8 items-center justify-center rounded-full text-lg text-[var(--brand)] transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-200 disabled:hover:bg-transparent"
        >
          &#8249;
        </button>
        <span className="font-[family-name:var(--font-heading)] text-sm font-semibold text-[var(--brand)]">
          {format(viewMonth, 'MMMM yyyy')}
        </span>
        <button
          type="button"
          onClick={() =>
            setMonthIndex((i) => Math.min(months.length - 1, i + 1))
          }
          disabled={safeIndex === months.length - 1}
          aria-label="Next month"
          className="flex size-8 items-center justify-center rounded-full text-lg text-[var(--brand)] transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-200 disabled:hover:bg-transparent"
        >
          &#8250;
        </button>
      </div>

      {/* Weekday header */}
      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((w) => (
          <div
            key={w}
            className="text-center text-[10px] font-medium text-gray-400"
          >
            {w}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-1">
        {grid.map((day) => {
          const inMonth = isSameMonth(day, viewMonth)
          const entry = inMonth
            ? byDay.get(format(day, 'yyyy-MM-dd'))
            : undefined
          const today = inMonth && isToday(day)
          const todayMarker = today ? (
            <span className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-[var(--brand)]" />
          ) : null

          if (!entry) {
            return (
              <div
                key={day.toISOString()}
                aria-current={today ? 'date' : undefined}
                className={cn(
                  'relative flex aspect-square items-center justify-center rounded-lg text-xs',
                  today
                    ? 'font-semibold text-[var(--brand)]'
                    : inMonth
                      ? 'text-gray-300'
                      : 'text-transparent'
                )}
              >
                {format(day, 'd')}
                {todayMarker}
              </div>
            )
          }

          const isSelected = entry.id === selectedId
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onSelect(entry.id)}
              aria-pressed={isSelected}
              aria-current={today ? 'date' : undefined}
              aria-label={`${format(day, 'EEEE d MMMM')}${today ? ' (today)' : ''} — ${
                entry.status === 'low'
                  ? 'low availability'
                  : entry.status === 'closed'
                    ? 'closed'
                    : entry.status === 'current'
                      ? 'current booking date'
                      : 'available'
              }`}
              className={cn(
                'relative flex aspect-square items-center justify-center rounded-lg border text-xs font-semibold transition-shadow',
                STATUS_CHIP[entry.status],
                isSelected && 'ring-2 ring-[var(--brand)] ring-offset-1'
              )}
            >
              {format(day, 'd')}
              {todayMarker}
            </button>
          )
        })}
      </div>
    </div>
  )
}
