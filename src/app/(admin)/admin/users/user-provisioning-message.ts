/**
 * Outcome copy for the admin "Add User" dialog (#575 follow-up).
 *
 * The create-user EF does not always create someone. Anyone who has ever
 * requested a login code on the resident booking portal already has an auth
 * account (the on_auth_user_created trigger assigns them `resident`), so adding
 * them as staff upgrades that account in place. Claiming "User Created" there
 * is untrue and hides the fact that their resident account is the same login.
 */
import type { Database } from '@/lib/supabase/types'

type AppRole = Database['public']['Enums']['app_role']

/** Admin-facing role names. Single source for the role select and this copy. */
export const ROLE_LABELS: Record<AppRole, string> = {
  'contractor-admin': 'Contractor Admin',
  'contractor-staff': 'Contractor Staff',
  field: 'Contractor Field',
  'client-admin': 'Client Admin',
  'client-staff': 'Client Staff',
  ranger: 'Client Ranger',
  resident: 'Resident',
  strata: 'Strata User',
}

export type UserProvisioningOutcome = {
  /** Dialog heading — must not claim creation when nothing was created. */
  title: string
  /** Extra explanation, or null when "User Created" already tells the whole story. */
  notice: string | null
}

export function describeUserProvisioning({
  existingAccount,
  previousRole,
  role,
}: {
  existingAccount: boolean
  previousRole: AppRole | null
  role: AppRole
}): UserProvisioningOutcome {
  if (!existingAccount) {
    return { title: 'User Created', notice: null }
  }

  const newLabel = ROLE_LABELS[role]

  if (previousRole === 'resident') {
    return {
      title: 'Access Added',
      notice: `This person already had a resident account on the booking portal. It has been given ${newLabel} access — no new account was created.`,
    }
  }

  if (!previousRole) {
    return {
      title: 'Access Added',
      notice: `This person already had a Verco account. It has been given ${newLabel} access — no new account was created.`,
    }
  }

  if (previousRole === role) {
    return {
      title: 'Access Updated',
      notice: `This person already had ${newLabel} access. Their contact details have been updated.`,
    }
  }

  return {
    title: 'Access Updated',
    notice: `This person already had ${ROLE_LABELS[previousRole]} access. It has been changed to ${newLabel}.`,
  }
}
