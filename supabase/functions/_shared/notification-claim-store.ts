// EF-only shared module (NOT mirrored — consumers are Deno EFs).
//
// The PostgREST side of the send claim (#671): send-notification (via the
// dispatcher) and notify-ticket-response both claim a notification_log key
// here before sending. The key is the unique index
// notification_log_send_claim_key — (booking_id, notification_type, channel,
// reference_id) NULLS NOT DISTINCT WHERE status IN ('queued', 'sent') — so a
// NULL booking (a ticket with no booking) or a NULL reference (booking-level
// types) is its own key value. The holder lookup matches that exactly with
// IS NULL, never "any value".
//
// Service-role client only (the claim must see every row for the key, and no
// app role may write a `queued` row).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0'
import type { Database } from './database.types.ts'
import type { SendClaimStore } from './dispatch.ts'

export function notificationClaimStore(supabase: SupabaseClient<Database>): SendClaimStore {
  return {
    insertClaim: async (row) => {
      const { data, error } = await supabase
        .from('notification_log')
        .insert({
          booking_id: row.booking_id,
          contact_id: row.contact_id,
          client_id: row.client_id,
          channel: row.channel,
          notification_type: row.notification_type,
          to_address: row.to_address,
          status: 'queued',
          reference_id: row.reference_id ?? null,
        })
        .select('id')
        .single()
      if (error?.code === '23505') return { conflict: true }
      if (error || !data) return { error: error?.message ?? 'claim insert returned no row' }
      return { id: data.id }
    },
    findHolder: async (row) => {
      let q = supabase
        .from('notification_log')
        .select('id, status, created_at')
        .eq('notification_type', row.notification_type)
        .eq('channel', row.channel)
        .in('status', ['queued', 'sent'])
      q = row.booking_id ? q.eq('booking_id', row.booking_id) : q.is('booking_id', null)
      q = row.reference_id ? q.eq('reference_id', row.reference_id) : q.is('reference_id', null)
      const { data, error } = await q.limit(1).maybeSingle()
      if (error) return { error: error.message }
      return data
    },
    releaseClaim: async (id, reason) => {
      const { data, error } = await supabase
        .from('notification_log')
        .update({ status: 'failed', error_message: reason })
        .eq('id', id)
        .eq('status', 'queued')
        .select('id')
      if (error) {
        console.error('releaseClaim failed:', error.message)
        return false
      }
      return (data ?? []).length > 0
    },
  }
}
