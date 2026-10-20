// EF-only shared module (NOT mirrored — reads Deno.env).

/**
 * A positive-integer tuning knob from an Edge Function secret, or `fallback`
 * when it is unset, non-numeric or ≤ 0 (watchdog windows and thresholds).
 * Not for credentials — those are read where they're used, with an error
 * naming the missing secret.
 */
export function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
