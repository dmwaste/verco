'use server'

import type { Result } from '@/lib/result'
import { verifyStaffRole } from '@/lib/auth/server'
import { OPENABLE_STATUSES } from '@/lib/exceptions/status'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Staff "open an investigation on behalf of a resident" (e.g. one who phoned or
 * emailed instead of disputing online). Advances an existing notice from
 * Issued/Disputed → Under Review, so it registers as an open investigation
 * (sidebar badge + dashboard) and the notice detail page's resolution actions
 * become available.
 *
 * Only advances an EXISTING record — every exception has one (field closeout
 * plus the legacy backfill). Record-less exceptions are surfaced by the dashboard
 * warning banner + backfill reconciliation, never opened here.
 *
 * Authorisation is enforced by RLS (staff role + tenant scope) and the
 * `enforce_notice_update_rules` trigger; this action is defence-in-depth and the
 * user-facing entry point. The `.in(status)` filter + row-count check closes the
 * race where a sibling staffer already opened the same notice.
 */
export async function openInvestigation(input: {
  kind: 'ncn' | 'np'
  noticeId: string
}): Promise<Result<void>> {
  if (input.kind !== 'ncn' && input.kind !== 'np') {
    return { ok: false, error: 'Invalid exception type.' }
  }
  if (!UUID_RE.test(input.noticeId)) {
    return { ok: false, error: 'Invalid investigation reference.' }
  }

  const auth = await verifyStaffRole()
  if (!auth) return { ok: false, error: 'Insufficient permissions.' }
  const { supabase } = auth

  // Branch on kind so the Supabase types stay concrete (a runtime table union
  // widens the update payload type and loses the enum literal).
  const result =
    input.kind === 'ncn'
      ? await supabase
          .from('non_conformance_notice')
          .update({ status: 'Under Review' })
          .eq('id', input.noticeId)
          .in('status', [...OPENABLE_STATUSES])
          .select('id')
      : await supabase
          .from('nothing_presented')
          .update({ status: 'Under Review' })
          .eq('id', input.noticeId)
          .in('status', [...OPENABLE_STATUSES])
          .select('id')

  if (result.error) return { ok: false, error: result.error.message }
  if (!result.data || result.data.length === 0) {
    return { ok: false, error: 'This investigation is already open or resolved.' }
  }
  return { ok: true, data: undefined }
}
