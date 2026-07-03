'use client'

import { cn } from '@/lib/utils'

interface PaginationProps {
  /** 0-based page index */
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  className?: string
}

const BUTTON_CLASS =
  'rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 disabled:opacity-40'

/**
 * The one admin list pagination (replaces three divergent hand-rolled
 * variants). Renders nothing when everything fits on one page.
 */
export function Pagination({ page, pageSize, total, onPageChange, className }: PaginationProps) {
  const totalPages = Math.ceil(total / pageSize)
  if (totalPages <= 1) return null

  return (
    <div className={cn('mt-4 flex items-center justify-between text-xs text-gray-500', className)}>
      <span className="tabular-nums">
        Showing {page * pageSize + 1}&ndash;{Math.min((page + 1) * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className={BUTTON_CLASS}
        >
          Previous
        </button>
        <span className="tabular-nums">
          Page {page + 1} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          className={BUTTON_CLASS}
        >
          Next
        </button>
      </div>
    </div>
  )
}
