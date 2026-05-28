'use server'

import { createClient } from '@/lib/supabase/server'
import type { Result } from '@/lib/result'
import { STAFF_ROLES } from '@/lib/auth/roles'
import type { StaffRole } from '@/lib/auth/roles'

/**
 * Validates the current user has a staff role.
 * Returns the supabase client + userId for reuse in the caller, or null if not authorised.
 */
export async function verifyStaffRole() {
  const supabase = await createClient()
  const { data: role, error: roleError } = await supabase.rpc('current_user_role')
  if (roleError) {
    console.error('[verifyStaffRole] RPC failed:', roleError.message)
    return null
  }
  if (!role || !STAFF_ROLES.includes(role as StaffRole)) return null
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError) {
    console.error('[verifyStaffRole] getUser failed:', userError.message)
    return null
  }
  return user ? { supabase, userId: user.id } : null
}

/**
 * Validates the current user has a staff role.
 * Returns the role as a Result, suitable for early-return error handling.
 */
export async function validateStaffRole(): Promise<Result<StaffRole>> {
  const supabase = await createClient()
  const { data: role, error: roleError } = await supabase.rpc('current_user_role')
  if (roleError) {
    console.error('[validateStaffRole] RPC failed:', roleError.message)
    return { ok: false, error: 'Service error. Please try again.' }
  }
  if (!role || !STAFF_ROLES.includes(role as StaffRole)) {
    return { ok: false, error: 'Insufficient permissions. Admin role required.' }
  }
  return { ok: true, data: role as StaffRole }
}
