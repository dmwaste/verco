import type { ReactNode } from 'react'
import { BackLink } from '@/components/admin/back-link'

interface DetailHeaderProps {
  backHref: string
  backLabel: string
  title: string
  subtitle?: ReactNode
  /** Right side: status pills / action buttons. */
  children?: ReactNode
}

/**
 * Canonical admin detail-page header: back-link + title + optional subtitle,
 * with status pills / actions on the right. Replaces the six hand-rolled
 * variants across the booking/ncn/np/ticket/property/bug detail pages.
 */
export function DetailHeader({ backHref, backLabel, title, subtitle, children }: DetailHeaderProps) {
  return (
    <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
      <BackLink href={backHref} label={backLabel} />
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
            {title}
          </h1>
          {subtitle != null && (
            <p className="mt-0.5 text-body-sm text-gray-500">{subtitle}</p>
          )}
        </div>
        {children != null && (
          <div className="flex items-center gap-2">{children}</div>
        )}
      </div>
    </div>
  )
}
