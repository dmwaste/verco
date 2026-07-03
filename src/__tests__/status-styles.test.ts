import { describe, it, expect } from 'vitest'
import { Constants } from '@/lib/supabase/types'
import { getStatusOptions, type StatusEntity } from '@/lib/ui/status-styles'

/**
 * Restores the compile-time exhaustiveness that BookingStatusBadge's
 * Record<BookingStatus, …> used to give: getStatusStyle takes a plain string,
 * so an unmapped DB enum value now degrades to the grey fallback instead of
 * failing typecheck. This pins every entity map against its generated enum, so
 * a future migration + type-regen that adds a value fails here, not silently in
 * the UI. If this breaks after a migration, add the new value to the matching
 * map in lib/ui/status-styles.ts.
 */
describe('status-styles covers every DB enum value', () => {
  const cases: Array<[StatusEntity, readonly string[]]> = [
    ['booking', Constants.public.Enums.booking_status],
    ['ncn', Constants.public.Enums.ncn_status],
    ['np', Constants.public.Enums.np_status],
    ['ticket', Constants.public.Enums.ticket_status],
    ['ticketPriority', Constants.public.Enums.ticket_priority],
    ['bug', Constants.public.Enums.bug_report_status],
  ]

  it.each(cases)('%s map has an explicit style for every enum value', (entity, values) => {
    const mapped = new Set(getStatusOptions(entity))
    const missing = values.filter((v) => !mapped.has(v))
    expect(missing, `${entity} map is missing: ${missing.join(', ')}`).toEqual([])
  })
})
