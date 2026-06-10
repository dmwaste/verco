import type { Database } from '@/lib/supabase/types'

type NcnReason = Database['public']['Enums']['ncn_reason']

/**
 * Canonical NCN reason list — `satisfies` keeps it compile-checked against
 * the generated DB enum so a drifted migration fails the build, not the crew.
 */
export const NCN_REASONS = [
  'Collection Limit Exceeded',
  'Items Obstructed or Not On Verge',
  'Building Waste',
  'Car Parts',
  'Asbestos / Fibre Fence',
  'Food or Domestic Waste',
  'Glass',
  'Medical Waste',
  'Tyres',
  'Greens in Container',
  'Hazardous Waste',
  'Items Oversize',
  'Other',
] as const satisfies readonly NcnReason[]
