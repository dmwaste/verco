'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { SignOutButton } from '@/components/auth/sign-out-button'

interface FieldLayoutClientProps {
  role: string
  roleLabel: string
  areaCodes: string
  children: React.ReactNode
}

const runsTab = {
  label: 'Runs',
  href: '/field',
  icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5.5" cy="18.5" r="2.5"/>
      <circle cx="18.5" cy="18.5" r="2.5"/>
      <path d="M8 18.5h8"/>
      <path d="M3 14V7a2 2 0 0 1 2-2h9v9"/>
      <path d="M14 8h4l3 4v2.5"/>
    </svg>
  ),
}

const runSheetTab = {
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
}

const newIdTab = {
  label: 'New ID',
  href: '/field/illegal-dumping/new',
  icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="16"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
  ),
}

const lookupTab = {
  label: 'Lookup',
  href: '/field/lookup',
  icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
}

const myIdsTab = {
  label: 'My IDs',
  href: '/field/my-ids',
  icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/>
      <line x1="3" y1="12" x2="3.01" y2="12"/>
      <line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  ),
}

export function FieldLayoutClient({
  role,
  roleLabel,
  areaCodes,
  children,
}: FieldLayoutClientProps) {
  const pathname = usePathname()
  const today = format(new Date(), 'EEEE d MMMM yyyy')

  // Rangers: Lookup (pile → booking judgement) / New ID / My IDs. Crews:
  // the stop-model Runs picker plus the legacy per-booking Run Sheet as the
  // mixed-mode fallback until cutover (Phase 4).
  const tabs =
    role === 'ranger' ? [lookupTab, newIdTab, myIdsTab] : [runsTab, runSheetTab]

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Header — top padding absorbs the iOS status bar in standalone PWA
          mode (viewport-fit=cover); env() is 0 in regular browsers */}
      <div className="shrink-0 bg-[var(--brand)] px-5 pb-3 pt-[calc(0.875rem+env(safe-area-inset-top))]">
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

      {/* Content — bottom padding clears the fixed nav plus the iOS home
          indicator */}
      <div className="flex flex-1 flex-col overflow-y-auto pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {children}
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-0 right-0 flex border-t border-gray-100 bg-white pb-[env(safe-area-inset-bottom)]">
        {tabs.map((tab) => {
          // /field (Runs) owns the picker plus the stop-model surfaces;
          // Run Sheet owns the legacy per-booking pages.
          const isActive =
            tab.href === '/field'
              ? pathname === '/field' ||
                pathname.startsWith('/field/runs') ||
                pathname.startsWith('/field/stops')
              : tab.href === '/field/run-sheet'
                ? pathname === '/field/run-sheet' || pathname.startsWith('/field/booking')
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
