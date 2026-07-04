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
    ['bugPriority', Constants.public.Enums.bug_report_priority],
    ['role', Constants.public.Enums.app_role],
    ['mudOnboarding', Constants.public.Enums.mud_onboarding_status],
    // auditAction has no DB enum — audit_log.action is free text; pin the set we style.
    ['auditAction', ['INSERT', 'UPDATE', 'DELETE']],
    // refund has no DB enum either — pin the styled set so a renamed state can't fall through.
    ['refund', ['Pending', 'Approved', 'Rejected']],
    // run is derived (runStatus()) — pin the set so a renamed state can't fall through to grey.
    ['run', ['Not started', 'In progress', 'Complete', 'Has exceptions']],
  ]

  it.each(cases)('%s map has an explicit style for every enum value', (entity, values) => {
    const mapped = new Set(getStatusOptions(entity))
    const missing = values.filter((v) => !mapped.has(v))
    expect(missing, `${entity} map is missing: ${missing.join(', ')}`).toEqual([])
  })
})
