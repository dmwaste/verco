'use client'

import { AdminSidebar } from '@/components/admin/admin-sidebar'
import { AdminSearchBar } from '@/components/admin/admin-search-bar'
import { ClientSwitcher } from '@/components/admin/client-switcher'
import { BugReportFab } from '@/components/bug-report/bug-report-fab'
import { SignOutButton } from '@/components/auth/sign-out-button'
import { VercoLogo } from '@/components/branding/verco-logo'

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
        <div className="flex w-60 shrink-0 items-center">
          {/* Verco lockup, reversed/white variant for the navy bar. */}
          <VercoLogo
            variant="reversed"
            iconClassName="size-8 shrink-0"
            wordmarkClassName="text-base"
            className="gap-2.5"
          />
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
