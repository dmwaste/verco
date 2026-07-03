import type { Database } from '@/lib/supabase/types'
import { StatusBadge } from '@/components/status-badge'

type BookingStatus = Database['public']['Enums']['booking_status']

interface BookingStatusBadgeProps {
  status: BookingStatus
  className?: string
}

/** Typed wrapper over StatusBadge — colours live in lib/ui/status-styles.ts. */
export function BookingStatusBadge({ status, className }: BookingStatusBadgeProps) {
  return <StatusBadge entity="booking" status={status} className={className} />
}
