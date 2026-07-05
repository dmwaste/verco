import { TenantBrandMark } from '@/components/branding/tenant-brand-mark'

/**
 * Tenant brand header for the survey terminal states (thank-you, already
 * submitted, unavailable). Sits on the dark `--brand` bar; the shared mark puts
 * the tenant's light logo (or initial fallback) on the tenant primary colour.
 * Mirrors the survey form's own header — NEVER the Verco mark (white-label).
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
      <TenantBrandMark
        name={serviceName}
        logoUrl={logoUrl}
        boxClass="h-8 rounded-md"
        logoClass="h-5"
        textClass="text-sm"
      />
      <span className="font-[family-name:var(--font-heading)] text-body font-bold text-white">
        {serviceName}
      </span>
    </div>
  )
}
