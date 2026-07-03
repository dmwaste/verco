'use client'

import { useState } from 'react'
import { format } from 'date-fns'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'

interface AuditTimelineProps {
  entries: ResolvedAuditEntry[]
  maxVisible?: number
}

export function AuditTimeline({ entries, maxVisible = 10 }: AuditTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)

  if (entries.length === 0) return null

  const visible = showAll ? entries : entries.slice(0, maxVisible)
  const hasMore = entries.length > maxVisible

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div className="border-b border-gray-100 px-5 py-4">
      <div className="mb-3 text-2xs font-semibold uppercase tracking-wide text-gray-500">
        Activity
      </div>
      <div className="flex flex-col gap-3">
        {visible.map((entry) => {
          const isExpanded = expandedIds.has(entry.id)
          const meaningfulChanges = entry.changes.length

          return (
            <div key={entry.id} className="flex items-start gap-2.5">
              <div className="mt-1.5 size-1.5 shrink-0 rounded-full bg-gray-300" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs font-medium text-gray-900">
                    {entry.summary}
                  </div>
                  {entry.actorName && (
                    <div className="shrink-0 text-caption text-gray-500">
                      {entry.actorName}
                    </div>
                  )}
                  {!entry.actorName && (
                    <div className="shrink-0 text-caption italic text-gray-400">
                      System
                    </div>
                  )}
                </div>
                <div className="text-caption text-gray-500">
                  {format(new Date(entry.createdAt), 'd MMM yyyy, h:mmaaa')}
                </div>

                {meaningfulChanges > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(entry.id)}
                    className="mt-1 text-caption font-medium text-[var(--brand,#293F52)] hover:underline"
                  >
                    {isExpanded
                      ? 'Hide changes'
                      : `Show changes (${meaningfulChanges} ${meaningfulChanges === 1 ? 'field' : 'fields'})`}
                  </button>
                )}

                {isExpanded && (
                  <div className="mt-1.5 flex flex-col gap-1 border-l-2 border-gray-100 pl-3">
                    {entry.changes.map((change, i) => (
                      <div key={i} className="text-caption text-gray-600">
                        <span className="font-medium text-gray-700">{change.field}:</span>{' '}
                        {entry.action === 'DELETE' ? (
                          <span className="text-red-500 line-through">{change.oldValue ?? '—'}</span>
                        ) : entry.action === 'INSERT' ? (
                          <span>{change.newValue ?? '—'}</span>
                        ) : (
                          <>
                            <span className="text-gray-400">{change.oldValue ?? '—'}</span>
                            <span className="mx-1 text-gray-300">&rarr;</span>
                            <span>{change.newValue ?? '—'}</span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-3 text-caption font-medium text-[var(--brand,#293F52)] hover:underline"
        >
          Show {entries.length - maxVisible} more entries
        </button>
      )}
    </div>
  )
}
