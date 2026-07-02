'use client'

import type { PeriodPreset } from '@/lib/reports/periods'

/**
 * Standard period presets for /admin/reports (VER-297, Dan 02/07): This week ·
 * Last week · This month · Last month · This FY · Last FY, plus a Custom
 * escape hatch that reveals the original date inputs. Presets resolve to AWST
 * bounds in lib/reports/periods.ts — this component is chrome only.
 */

const PRESET_LABELS: Array<{ id: PeriodPreset; label: string }> = [
  { id: 'this-week', label: 'This week' },
  { id: 'last-week', label: 'Last week' },
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'this-fy', label: 'This FY' },
  { id: 'last-fy', label: 'Last FY' },
  { id: 'custom', label: 'Custom' },
]

export function PeriodSelector({
  preset,
  onPresetChange,
  customFrom,
  customTo,
  onCustomChange,
}: {
  preset: PeriodPreset
  onPresetChange: (preset: PeriodPreset) => void
  customFrom: string
  customTo: string
  onCustomChange: (from: string, to: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border-[1.5px] border-gray-100 bg-white p-1">
        {PRESET_LABELS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onPresetChange(id)}
            className={`rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors ${
              preset === id
                ? 'bg-[#293F52] text-white'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => onCustomChange(e.target.value, customTo)}
            aria-label="From date"
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
          />
          <span className="text-body-sm text-gray-400">–</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => onCustomChange(customFrom, e.target.value)}
            aria-label="To date"
            className="rounded-lg border-[1.5px] border-gray-100 bg-white px-3 py-[7px] text-body-sm text-gray-700"
          />
        </>
      )}
    </div>
  )
}
