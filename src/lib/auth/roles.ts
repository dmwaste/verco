export type StaffRole = 'contractor-admin' | 'contractor-staff' | 'client-admin' | 'client-staff'

export const STAFF_ROLES: readonly StaffRole[] = [
  'contractor-admin',
  'contractor-staff',
  'client-admin',
  'client-staff',
]

/**
 * Roles allowed to adjust allocation overrides (add / reduce / edit): the whole
 * contractor tier plus client-admin — deliberately NOT client-staff (VER-304).
 * Mirrored by the allocation_override INSERT/UPDATE RLS policies; this helper
 * only gates the UI, RLS is the enforcement.
 */
export function canManageAllocations(role: string | null | undefined): boolean {
  return role === 'contractor-admin' || role === 'contractor-staff' || role === 'client-admin'
}
