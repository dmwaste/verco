'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { SignOutButton } from '@/components/auth/sign-out-button'

interface Tab {
  label: string
  href: string
  icon: (active: boolean) => React.ReactNode
}

const BASE_TABS: Tab[] = [
  {
    label: 'Home',
    href: '/',
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--brand)' : '#B0B0B0'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    label: 'Bookings',
    href: '/dashboard',
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--brand)' : '#B0B0B0'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    label: 'Support',
    href: '/contact',
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--brand)' : '#B0B0B0'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
]

const ADMIN_TAB: Tab = {
  label: 'Admin',
  href: '/admin',
  icon: (active: boolean) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? 'var(--brand)' : '#B0B0B0'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
}

interface MobileBottomNavProps {
  showAdminLink?: boolean
  showSignOut?: boolean
  adminUrl: string
}

export function MobileBottomNav({ showAdminLink, showSignOut, adminUrl }: MobileBottomNavProps) {
  const pathname = usePathname()

  function isActive(href: string) {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 flex border-t border-gray-100 bg-white tablet:hidden">
      {BASE_TABS.map((tab) => {
        const active = isActive(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex flex-1 flex-col items-center gap-1 pb-4 pt-2.5 text-2xs font-medium ${
              active ? 'text-[var(--brand)]' : 'text-gray-500'
            }`}
          >
            {tab.icon(active)}
            {tab.label}
          </Link>
        )
      })}
      {showAdminLink && (
        // Cross-host link to the operator surface (admin.verco.au) — a plain
        // <a> for a full navigation, not an in-app <Link>. Never "active"
        // since it lives on a different host than this resident page.
        <a
          href={adminUrl}
          className="flex flex-1 flex-col items-center gap-1 pb-4 pt-2.5 text-2xs font-medium text-gray-500"
        >
          {ADMIN_TAB.icon(false)}
          {ADMIN_TAB.label}
        </a>
      )}
      {showSignOut && (
        <SignOutButton
          destination="home"
          formClassName="flex-1"
          className="flex w-full flex-col items-center gap-1 pb-4 pt-2.5 text-2xs font-medium text-gray-500"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out
        </SignOutButton>
      )}
    </div>
  )
}
