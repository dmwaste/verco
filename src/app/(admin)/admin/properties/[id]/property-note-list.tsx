import type { ReactNode } from 'react'
import { Pill } from '@/components/status-badge'
import { PROPERTY_NOTE_KIND_LABELS, formatFileSize, type PropertyNoteKind } from '@/lib/property-notes/validation'
import type { PropertyNoteView } from '@/lib/property-notes/load'

/**
 * The entries of a property's notes & documents (ADR 0031), newest first.
 * Shared by the property page (with Remove) and the caller lookup (read-only,
 * VER-321). No hooks, so it renders as a server or client component.
 */

const AWST_DATE = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Perth',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

function kindLabel(kind: string): string {
  return PROPERTY_NOTE_KIND_LABELS[kind as PropertyNoteKind] ?? kind
}

export function PropertyNoteList({
  notes,
  renderAction,
}: {
  notes: PropertyNoteView[]
  /** Per-entry control on the right, e.g. the property page's Remove. */
  renderAction?: (note: PropertyNoteView) => ReactNode
}) {
  return (
    <ul className="divide-y divide-gray-100 border-t border-gray-100">
      {notes.map((note) => (
        <li key={note.id} className="flex items-start justify-between gap-4 px-5 py-3">
          <div className="min-w-0 space-y-1.5">
            <Pill tone={note.kind === 'access_form' ? 'info' : 'neutral'}>{kindLabel(note.kind)}</Pill>
            {note.body && (
              <p className="whitespace-pre-wrap break-words text-body-sm text-gray-900">{note.body}</p>
            )}
            {note.file_name &&
              (note.file_url ? (
                <a
                  href={note.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 text-body-sm font-medium text-[#293F52] underline-offset-2 hover:underline"
                >
                  <span className="truncate">{note.file_name}</span>
                  {note.file_size != null && (
                    <span className="shrink-0 text-xs font-normal text-gray-500">
                      {formatFileSize(note.file_size)}
                    </span>
                  )}
                </a>
              ) : (
                <p className="text-body-sm text-status-warn">{note.file_name} (file unavailable)</p>
              ))}
            <p className="text-xs text-gray-500">
              Added by {note.author_name ?? 'staff'} · {AWST_DATE.format(new Date(note.created_at))}
            </p>
          </div>
          {renderAction?.(note)}
        </li>
      ))}
    </ul>
  )
}
