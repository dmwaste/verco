import { EmailEntryForm } from './email-entry-form'
import { resolveAuthHostContext } from './_host-context'
import { VercoLogo } from '@/app/landing/logos'
import { TenantBrandMark } from '@/components/branding/tenant-brand-mark'

export default async function AuthPage() {
  const { brand } = await resolveAuthHostContext()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-100 px-4">
      <div className="w-full max-w-sm">
        {/* Brand block — Verco logo on the operator hosts (admin/field); the
            tenant's own initial + service name on resident subdomains. */}
        <div className="flex flex-col items-center gap-2.5 pb-10 pt-8">
          {brand.variant === 'verco' ? (
            <VercoLogo variant="colour" />
          ) : (
            <div className="flex items-center gap-2.5">
              <TenantBrandMark
                name={brand.serviceName}
                logoUrl={brand.logoUrl}
                boxClass="h-10 rounded-[10px]"
                logoClass="h-7"
                textClass="text-title"
              />
              <span className="font-[family-name:var(--font-heading)] text-title font-bold text-[var(--brand)]">
                {brand.serviceName}
              </span>
            </div>
          )}
          {brand.contextLabel && (
            <span className="text-body-sm text-gray-500">{brand.contextLabel}</span>
          )}
        </div>

        {/* Form card */}
        <EmailEntryForm />

        {/* Powered by */}
        <div className="flex items-center justify-center gap-1.5 pt-8 text-caption text-gray-300">
          Booking platform powered by
          <span className="rounded bg-gray-100 px-1.5 py-px font-[family-name:var(--font-heading)] text-2xs font-bold text-gray-500">
            VERCO
          </span>
        </div>
      </div>
    </div>
  )
}
