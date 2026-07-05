import Link from 'next/link'
import { SignOutButton } from '@/components/auth/sign-out-button'
import { TenantBrandMark } from '@/components/branding/tenant-brand-mark'

interface PublicNavProps {
  serviceName: string
  logoUrl: string | null
  showPoweredBy: boolean
  showAdminLink?: boolean
  showSignOut?: boolean
  adminUrl: string
}

export function PublicNav({
  serviceName,
  logoUrl,
  showPoweredBy,
  showAdminLink,
  showSignOut,
  adminUrl,
}: PublicNavProps) {
  return (
    <nav className="sticky top-0 z-50 bg-[var(--brand)]">
      <div className="flex h-16 items-center justify-between px-8">
        {/* Logo only — the tenant wordmark/crest carries the brand, so we don't
            render the service name beside it (avoids doubling, e.g. the Verge
            Valet logo already reads "VergeValet"). serviceName stays as alt text.
            The lettermark box is the fallback for tenants with no logo. */}
        <Link href="/" className="flex items-center">
          <TenantBrandMark
            name={serviceName}
            logoUrl={logoUrl}
            boxClass="h-8 rounded-lg"
            logoClass="h-8"
            textClass="text-lg md:text-xl"
          />
        </Link>

        {/* Desktop nav */}
        <div className="hidden flex-1 items-center justify-end gap-6 tablet:flex">
          <Link
            href="/dashboard"
            className="text-sm md:text-base font-medium text-[#C7D3DD] hover:text-white"
          >
            My Dashboard
          </Link>
          <Link
            href="/contact#faqs"
            className="text-sm md:text-base font-medium text-[#C7D3DD] hover:text-white"
          >
            FAQs
          </Link>
          <Link
            href="/contact"
            className="text-sm md:text-base font-medium text-[#C7D3DD] hover:text-white"
          >
            Contact Us
          </Link>
          <Link
            href="/book"
            className="rounded-lg bg-[var(--brand-accent)] px-5 py-2 font-[family-name:var(--font-heading)] text-sm md:text-base font-semibold text-[var(--brand)]"
          >
            Book a Collection
          </Link>
          {showAdminLink && (
            <a
              href={adminUrl}
              className="text-sm font-medium text-[#8FA5B8] hover:text-white"
            >
              Admin
            </a>
          )}
          {showSignOut && (
            <SignOutButton
              destination="home"
              className="text-sm md:text-base font-medium text-[#C7D3DD] hover:text-white"
            />
          )}
          {showPoweredBy && (
            <div className="ml-4 flex items-center gap-1.5 border-l border-white/10 pl-4 text-caption md:text-body-sm text-[#8FA5B8]">
              Powered by
              <span className="rounded border border-white/[0.12] bg-white/[0.08] px-1.5 py-0.5 font-[family-name:var(--font-heading)] text-2xs md:text-xs font-semibold text-[#C7D3DD]">
                VERCO
              </span>
            </div>
          )}
        </div>
      </div>
    </nav>
  )
}
