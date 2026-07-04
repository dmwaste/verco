'use client'

import { AdminSidebar } from '@/components/admin/admin-sidebar'
import { AdminSearchBar } from '@/components/admin/admin-search-bar'
import { ClientSwitcher } from '@/components/admin/client-switcher'
import { BugReportFab } from '@/components/bug-report/bug-report-fab'
import { SignOutButton } from '@/components/auth/sign-out-button'

interface AdminLayoutClientProps {
  currentClient: { id: string; name: string } | null
  accessibleClients: Array<{ id: string; name: string }>
  initials: string
  counts: {
    bookings: number
    ncn: number
    np: number
    tickets: number
  }
  role: string | null
  children: React.ReactNode
}

export function AdminLayoutClient({
  currentClient,
  accessibleClients,
  initials,
  counts,
  role,
  children,
}: AdminLayoutClientProps) {
  return (
    <div className="admin-surface flex h-screen flex-col print:h-auto print:overflow-visible">
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center gap-4 bg-[#293F52] px-5 print:hidden">
        <div className="flex w-60 shrink-0 items-center gap-2.5">
          {/* Verco logo mark (reversed/white variant, for the navy bar). The
              green-leaf + white-circle icon is inlined as vectors; the "VERCO"
              wordmark stays HTML text in the already-loaded heading font
              (Poppins Bold) — identical to the brand SVG's wordmark, without a
              fragile in-SVG webfont dependency. viewBox cropped to the icon's
              measured bbox (208.46² at 17.2,15.09) with even padding. */}
          <svg viewBox="7 5 229 229" className="size-8 shrink-0" aria-hidden="true">
            <path
              fill="#00E47C"
              d="M224.1,101.9c-7.5-49-53.1-87.6-102.7-86.8,0,0-17.4,0-17.4,0,0,0,0,17.2,0,32.2s8.5,19.5,19.2,20,11.2,1,15.5,2.8c34.2,10.9,46.2,57.9,21.4,83.8-13.4,16.5-36.2,18.6-56.1,17.3-9.7,0-25.1,0-34.7,0,0-15.5,0-32.8,0-49.4,0-11-8.9-20-20-20-14.3,0-30.7,0-32.1,0,0,15.5,0,36.6,0,52.1,0,21.7,0,47.7,0,69.4,8.7,0,26,0,34.7,0,28-.8,59,1.8,86.8-1.4,55.3-8.2,95.8-65.1,85.3-120Z"
            />
            <circle fill="#FFFFFF" cx="52" cy="49.9" r="34.7" />
          </svg>
          <span className="font-[family-name:var(--font-heading)] text-base font-bold text-white">
            VERCO
          </span>
        </div>

        {/* Tenant pill / switcher */}
        {currentClient && (
          <ClientSwitcher current={currentClient} accessible={accessibleClients} />
        )}

        <div className="flex-1" />

        {/* Search */}
        <AdminSearchBar />

        {/* Avatar + sign-out */}
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-full bg-[#3A5A73] text-body-sm font-semibold text-white">
            {initials}
          </div>
          <SignOutButton
            destination="login"
            className="text-body-sm font-medium text-[#8FA5B8] transition-colors hover:text-white"
          />
        </div>
      </div>

      {/* Body: sidebar + main */}
      <div className="flex flex-1 overflow-hidden print:overflow-visible">
        <AdminSidebar counts={counts} role={role} />
        <main className="flex flex-1 flex-col overflow-y-auto bg-gray-50 print:overflow-visible print:bg-white">
          {children}
        </main>
      </div>

      {/* Bug-report FAB — desktop only, every admin page */}
      <div className="print:hidden">
        <BugReportFab />
      </div>
    </div>
  )
}
