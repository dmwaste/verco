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

/**
 * Contractor-tier staff (D&M ops): contractor-admin + contractor-staff only.
 * Gates contractor-only admin surfaces (e.g. run sheets) — deliberately NOT
 * client-admin/client-staff, unlike canManageAllocations.
 *
 * For run sheets this guard is the SOLE enforcement, not defence-in-depth: the
 * proxy admits client-tier roles to /admin/*, the (admin) layout has no role
 * guard, and collection_stop RLS lets client-staff read their own stops. So a
 * page that doesn't redirect non-contractor roles would render an operator
 * surface to councils.
 */
export function isContractorStaff(role: string | null | undefined): boolean {
  return role === 'contractor-admin' || role === 'contractor-staff'
}
