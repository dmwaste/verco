'use server'

import { createClient } from '@/lib/supabase/server'
import { invokeSendNotification } from '@/lib/notifications/invoke'
import type { Result } from '@/lib/result'

export async function retryNotification(logId: string): Promise<Result<void>> {
  if (!logId) {
    return { ok: false, error: 'Log ID is required.' }
  }

  const supabase = await createClient()

  // Verify admin role
  const { data: role } = await supabase.rpc('current_user_role')
  const adminRoles = ['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff']
  if (!role || !adminRoles.includes(role)) {
    return { ok: false, error: 'Insufficient permissions.' }
  }

  // Lock the row, validate failed status, set to queued
  const { error: rpcError } = await supabase.rpc('retry_notification_log', {
    log_id: logId,
  })

  if (rpcError) {
    // 23505 = notification_log_send_claim_key (#671): another row for the same
    // notification + channel is already sent or sending, so re-queueing this
    // one would send the resident a second copy.
    if (rpcError.code === '23505') {
      return {
        ok: false,
        error: 'This notification has already gone out (or is sending now), so there is nothing to retry.',
      }
    }
    return { ok: false, error: rpcError.message }
  }

  // Dispatch via resume-by-log-id path (fire-and-forget)
  await invokeSendNotification(supabase, { notification_log_id: logId })

  return { ok: true, data: undefined }
}