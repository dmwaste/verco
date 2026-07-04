import type { ReactNode } from 'react'
import { getStatusStyle, type StatusEntity } from '@/lib/ui/status-styles'
import { cn } from '@/lib/utils'

const PILL_BASE =
  'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption font-semibold'

interface StatusBadgeProps {
  entity: StatusEntity
  status: string
  className?: string
  /** Render a leading status dot when the entity style defines one (e.g. tickets). */
  dot?: boolean
}

/**
 * The one status pill. Wraps getStatusStyle() so every surface renders the
 * same markup and colours — never re-type the rounded-full pill inline.
 */
export function StatusBadge({ entity, status, className, dot }: StatusBadgeProps) {
  const ss = getStatusStyle(entity, status)
  const showDot = dot && ss.dot

  return (
    <span className={cn(PILL_BASE, showDot && 'gap-1.5', ss.bg, ss.text, className)}>
      {showDot && <span className={cn('size-1.5 rounded-full', ss.dot)} />}
      {ss.label}
    </span>
  )
}

// Generic one-off pill for labels that are NOT a fixed enumerable status set.
// Same tokens as StatusBadge; use an entity + StatusBadge for enumerable sets.
const TONE = {
  success: { bg: 'bg-status-success-bg', text: 'text-status-success' },
  warn: { bg: 'bg-status-warn-bg', text: 'text-status-warn' },
  error: { bg: 'bg-status-error-bg', text: 'text-status-error' },
  info: { bg: 'bg-status-info-bg', text: 'text-status-info' },
  neutral: { bg: 'bg-gray-100', text: 'text-gray-600' },
} as const

export type PillTone = keyof typeof TONE

interface PillProps {
  tone: PillTone
  className?: string
  children: ReactNode
}

export function Pill({ tone, className, children }: PillProps) {
  const t = TONE[tone]
  return <span className={cn(PILL_BASE, t.bg, t.text, className)}>{children}</span>
}
