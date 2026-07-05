/**
 * Tenant brand header for the survey terminal states (thank-you, already
 * submitted, unavailable). Sits on the dark `--brand` bar, so the tenant's
 * light logo works directly; falls back to the tenant's initial in the accent
 * box. Mirrors the survey form's own header — NEVER the Verco mark, since the
 * survey is a tenant-facing (white-label) surface.
 */
export function SurveyBrandHeader({
  serviceName,
  logoUrl,
}: {
  serviceName: string
  logoUrl: string | null
}) {
  return (
    <div className="flex items-center gap-2">
      {logoUrl ? (
        <img src={logoUrl} alt={serviceName} className="h-[26px] w-auto" />
      ) : (
        <div className="flex size-[26px] items-center justify-center rounded-[6px] bg-[var(--brand-accent)] font-[family-name:var(--font-heading)] text-sm font-bold text-[var(--brand)]">
          {serviceName.charAt(0) || 'V'}
        </div>
      )}
      <span className="font-[family-name:var(--font-heading)] text-body font-bold text-white">
        {serviceName}
      </span>
    </div>
  )
}
