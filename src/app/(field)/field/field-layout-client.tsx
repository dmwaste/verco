'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { SignOutButton } from '@/components/auth/sign-out-button'

interface FieldLayoutClientProps {
  roleLabel: string
  areaCodes: string
  children: React.ReactNode
}

export function FieldLayoutClient({
  roleLabel,
  areaCodes,
  children,
}: FieldLayoutClientProps) {
  const pathname = usePathname()
  const today = format(new Date(), 'EEEE d MMMM yyyy')

  const tabs = [
    {
      label: 'Run Sheet',
      href: '/field/run-sheet',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1"/>
          <line x1="9" y1="12" x2="15" y2="12"/>
          <line x1="9" y1="16" x2="13" y2="16"/>
        </svg>
      ),
    },
    {
      label: 'Exceptions',
      href: '/field/exceptions',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      ),
    },
    {
      label: 'History',
      href: '/field/history',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      ),
    },
  ]

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Header */}
      <div className="shrink-0 bg-[var(--brand)] px-5 pb-3 pt-3.5">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-[7px] bg-[var(--brand-accent)] font-[family-name:var(--font-heading)] text-base font-bold text-[var(--brand)]">
              V
            </div>
            <span className="font-[family-name:var(--font-heading)] text-base font-bold text-white">
              VERCO
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-[#8FA5B8]">
              {roleLabel}
            </span>
            <SignOutButton
              destination="login"
              className="text-[11px] font-medium text-[#8FA5B8] transition-colors hover:text-white"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-body-sm text-[#C7D3DD]">{today}</span>
          {areaCodes && (
            <span className="rounded-full bg-[var(--brand-accent)]/15 px-2.5 py-0.5 text-[11px] font-semibold text-[var(--brand-accent)]">
              {areaCodes}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-y-auto pb-20">
        {children}
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 flex border-t border-gray-100 bg-white">
        {tabs.map((tab) => {
          const isActive =
            tab.href === '/field/run-sheet'
              ? pathname === '/field/run-sheet' || pathname === '/field'
              : pathname.startsWith(tab.href)

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'flex flex-1 flex-col items-center gap-1 pb-3.5 pt-2.5 text-2xs font-medium',
                isActive
                  ? 'text-[var(--brand)] [&_svg]:stroke-[var(--brand)]'
                  : 'text-gray-500 [&_svg]:stroke-gray-300'
              )}
            >
              {tab.icon}
              {tab.label}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
