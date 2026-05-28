'use server'

import { createClient } from '@/lib/supabase/server'
import type { Result } from '@/lib/result'

export const STAFF_ROLES: readonly string[] = [
  'contractor-admin',
  'contractor-staff',
  'client-admin',
  'client-staff',
]

/**
 * Validates the current user has a staff role.
 * Returns the supabase client + userId for reuse in the caller, or null if not authorised.
 */
export async function verifyStaffRole() {
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !STAFF_ROLES.includes(role)) return null
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user ? { supabase, userId: user.id } : null
}

/**
 * Validates the current user has a staff role.
 * Returns the role string as a Result, suitable for early-return error handling.
 */
export async function validateStaffRole(): Promise<Result<string>> {
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (!role || !STAFF_ROLES.includes(role)) {
    return { ok: false, error: 'Insufficient permissions. Admin role required.' }
  }
  return { ok: true, data: role }
}
