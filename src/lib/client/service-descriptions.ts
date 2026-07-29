import type { Json } from '@/lib/supabase/types'

/**
 * Per-tenant "what we collect" copy override (#454). `client.service_descriptions`
 * is a jsonb map of service name → description; a missing key (or malformed
 * value — it's admin-authored jsonb, not schema-enforced) falls back to the
 * app's built-in copy. Returns null when no valid override exists.
 */
export function resolveServiceDescription(
  overrides: Json | null | undefined,
  serviceName: string
): string | null {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null
  const value = overrides[serviceName]
  return typeof value === 'string' && value.length > 0 ? value : null
}
