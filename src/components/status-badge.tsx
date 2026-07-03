import { getStatusStyle, type StatusEntity } from '@/lib/ui/status-styles'
import { cn } from '@/lib/utils'

interface StatusBadgeProps {
  entity: StatusEntity
  status: string
  className?: string
}

/**
 * The one status pill. Wraps getStatusStyle() so every surface renders the
 * same markup and colours — never re-type the rounded-full pill inline.
 */
export function StatusBadge({ entity, status, className }: StatusBadgeProps) {
  const ss = getStatusStyle(entity, status)

  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption font-semibold',
        ss.bg,
        ss.text,
        className
      )}
    >
      {ss.label}
    </span>
  )
}
