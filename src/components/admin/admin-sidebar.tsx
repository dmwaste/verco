'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  badge?: { count: number; color?: 'red' | 'amber' | 'navy' }
}

interface NavSection {
  title: string
  items: NavItem[]
}

const ICON = {
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
  ),
  bookings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
  ),
  calendar: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
  ),
  properties: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
  ),
  ncn: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
  ),
  np: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
  ),
  tickets: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  ),
  refunds: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
  ),
  reports: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>
  ),
  users: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  bug: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/></svg>
  ),
  allocations: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
  ),
  notifications: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
  ),
  auditLog: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
  ),
  clients: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>
  ),
}

interface AdminSidebarProps {
  counts?: {
    bookings?: number
    ncn?: number
    np?: number
    tickets?: number
  }
  role?: string | null
}

export function AdminSidebar({ counts, role }: AdminSidebarProps) {
  const pathname = usePathname()

  let sections: NavSection[] = [
    {
      title: 'General',
      items: [
        { label: 'Dashboard', href: '/admin', icon: ICON.dashboard },
      ],
    },
    {
      title: 'Operations',
      items: [
        {
          label: 'Bookings',
          href: '/admin/bookings',
          icon: ICON.bookings,
          badge: counts?.bookings
            ? { count: counts.bookings, color: 'navy' }
            : undefined,
        },
        {
          label: 'Collection Dates',
          href: '/admin/collection-dates',
          icon: ICON.calendar,
        },
        { label: 'Properties', href: '/admin/properties', icon: ICON.properties },
        { label: 'Allocations', href: '/admin/allocations', icon: ICON.allocations },
      ],
    },
    {
      title: 'Exceptions',
      items: [
        {
          label: 'Non-Conformance',
          href: '/admin/non-conformance',
          icon: ICON.ncn,
          badge: counts?.ncn ? { count: counts.ncn, color: 'red' } : undefined,
        },
        {
          label: 'Nothing Presented',
          href: '/admin/nothing-presented',
          icon: ICON.np,
          badge: counts?.np ? { count: counts.np, color: 'amber' } : undefined,
        },
      ],
    },
    {
      title: 'Customer',
      items: [
        {
          label: 'Service Tickets',
          href: '/admin/service-tickets',
          icon: ICON.tickets,
          badge: counts?.tickets
            ? { count: counts.tickets, color: 'red' }
            : undefined,
        },
        { label: 'Refunds', href: '/admin/refunds', icon: ICON.refunds },
      ],
    },
    {
      title: 'Insights',
      items: [
        { label: 'Reports', href: '/admin/reports', icon: ICON.reports },
      ],
    },
    {
      title: 'Admin',
      items: [
        { label: 'Users', href: '/admin/users', icon: ICON.users },
        // Bug Reports nav moved into the contractor-admin block below — it's
        // the triage queue, contractor-internal. Client roles still submit
        // via the FAB; they just don't see the queue.
        { label: 'Notifications', href: '/admin/notifications', icon: ICON.notifications },
        { label: 'Audit Log', href: '/admin/audit-log', icon: ICON.auditLog },
      ],
    },
  ]

  if (role === 'contractor-admin') {
    sections.push({
      title: 'Configuration',
      items: [
        { label: 'Bug Reports', href: '/admin/bug-reports', icon: ICON.bug },
        { label: 'Clients', href: '/admin/clients', icon: ICON.clients },
        {
          label: 'Notification Templates',
          href: '/admin/notifications/templates',
          icon: ICON.notifications,
        },
      ],
    })
  }

  // Collect all hrefs once so isActive() can prefer the most-specific match.
  // Without this, navigating to /admin/notifications/templates highlights both
  // the parent /admin/notifications link AND the more-specific templates link.
  const allHrefs = sections.flatMap((s) => s.items.map((i) => i.href))

  function isActive(href: string): boolean {
    if (href === '/admin') return pathname === '/admin'
    if (!pathname.startsWith(href)) return false
    // If any sibling href is a longer prefix that also matches, defer to it.
    const moreSpecific = allHrefs.some(
      (h) => h !== href && h.startsWith(href + '/') && pathname.startsWith(h),
    )
    return !moreSpecific
  }

  const BADGE_COLORS = {
    red: 'bg-[#E53E3E]',
    amber: 'bg-[#FF8C42]',
    navy: 'bg-[#293F52]',
  } as const

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-gray-100 bg-white py-4">
      {sections.map((section) => (
        <div key={section.title} className="mb-1">
          <div className="px-5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.8px] text-gray-300">
            {section.title}
          </div>
          {section.items.map((item) => {
            const active = isActive(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'relative flex items-center gap-2.5 px-5 py-2.5 text-body-sm font-medium text-gray-700 transition-colors hover:bg-gray-50',
                  active &&
                    'bg-[#E8FDF0] font-semibold text-[#293F52] before:absolute before:bottom-1 before:left-0 before:top-1 before:w-[3px] before:rounded-r before:bg-[#00E47C]'
                )}
              >
                <span className="flex w-5 shrink-0 items-center justify-center">
                  {item.icon}
                </span>
                {item.label}
                {item.badge && (
                  <span
                    className={cn(
                      'ml-auto min-w-[18px] rounded-full px-1.5 py-px text-center text-2xs font-semibold text-white',
                      BADGE_COLORS[item.badge.color ?? 'red']
                    )}
                  >
                    {item.badge.count}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      ))}
    </aside>
  )
}
