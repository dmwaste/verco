'use client'

import { PERIOD_PRESETS, type PeriodPreset } from '@/lib/reports/periods'

/**
 * Standard period presets for /admin/reports (VER-297, Dan 02/07): This week ·
 * Last week · This month · Last month · This FY · Last FY, plus a Custom
 * escape hatch that reveals the original date inputs. Presets resolve to AWST
 * bounds in lib/reports/periods.ts — this component is chrome only.
 *
 * Labels are a Record over PeriodPreset and buttons render from the imported
 * PERIOD_PRESETS, so adding a preset without a label (or a button) is a
 * compile error rather than a silently missing pill.
 */

const PRESET_LABEL: Record<PeriodPreset, string> = {
  'this-week': 'This week',
  'last-week': 'Last week',
  'this-month': 'This month',
  'last-month': 'Last month',
  'this-fy': 'This FY',
  'last-fy': 'Last FY',
  custom: 'Custom',
}

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
      <div
        role="group"
        aria-label="Report period"
        className="flex flex-wrap items-center gap-1 rounded-lg border-[1.5px] border-gray-100 bg-white p-1"
      >
        {PERIOD_PRESETS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={preset === id}
            onClick={() => onPresetChange(id)}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
              preset === id
                ? 'bg-[#293F52] text-white'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
            // §21: text-white can silently fail under Tailwind v4 + Turbopack —
            // inline fallback so the selected pill's label can never vanish.
            style={preset === id ? { color: '#FFFFFF' } : undefined}
          >
            {PRESET_LABEL[id]}
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
