import { cn } from '@/lib/utils'

/**
 * Tenant brand mark — the tenant's light logo inside a rounded box filled with
 * the tenant's PRIMARY colour, falling back to the tenant's initial (white on
 * primary). Mirrors the landing council-picker treatment so every tenant-facing
 * surface reads the same. NEVER the Verco mark — tenant surfaces only (see
 * memory verco-logo-vs-tenant-branding).
 *
 * Colour source:
 *  - Multi-tenant lists (e.g. admin Clients list, per-row colour) → pass `colour`.
 *  - Single-tenant surfaces (auth, survey, footer, resident nav) → omit `colour`
 *    to inherit `var(--brand)` set by the layout.
 *
 * Sizing is caller-controlled: `boxClass` sets box height + rounding,
 * `logoClass` the logo height, `textClass` the fallback initial's font size.
 */
export function TenantBrandMark({
  name,
  logoUrl,
  colour,
  boxClass,
  logoClass,
  textClass,
}: {
  name: string
  logoUrl: string | null
  colour?: string | null
  boxClass?: string
  logoClass?: string
  textClass?: string
}) {
  const style = colour ? { backgroundColor: colour } : undefined
  const bg = colour ? '' : 'bg-[var(--brand)]'

  if (logoUrl) {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center rounded-lg px-2', bg, boxClass)}
        style={style}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic Supabase-hosted tenant logo */}
        <img
          src={logoUrl}
          alt={name}
          className={cn('w-auto max-w-[130px] object-contain object-left', logoClass)}
        />
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex aspect-square shrink-0 items-center justify-center rounded-lg font-[family-name:var(--font-heading)] font-bold text-white',
        bg,
        boxClass,
        textClass,
      )}
      style={style}
    >
      {name.charAt(0) || 'V'}
    </span>
  )
}
