'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { staleActionMessage } from '@/lib/bundle/stale-action'
import { Pill } from '@/components/status-badge'
import { FieldLabel, Select, Textarea } from '@/components/admin/form'
import {
  PROPERTY_DOCUMENTS_BUCKET,
  PROPERTY_NOTE_ACCEPT,
  PROPERTY_NOTE_BODY_MAX,
  PROPERTY_NOTE_KIND_LABELS,
  checkDocumentFile,
  formatFileSize,
  resolveFileType,
  type PropertyNoteKind,
} from '@/lib/property-notes/validation'
import { addPropertyNote, createPropertyDocumentUploadUrl, removePropertyNote } from './property-notes-actions'

/**
 * Staff notes and signed permission-to-enter forms on a property (ADR 0031).
 * Visible to D&M and the owning council's staff only (RLS). Entries can't be
 * edited; "Remove" hides one but keeps it on record.
 */

export interface PropertyNoteView {
  id: string
  kind: string
  body: string | null
  file_name: string | null
  file_size: number | null
  file_url: string | null
  created_at: string
  author_name: string | null
}

const AWST_DATE = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Perth',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

function kindLabel(kind: string): string {
  return PROPERTY_NOTE_KIND_LABELS[kind as PropertyNoteKind] ?? kind
}

export function PropertyNotesSection({
  propertyId,
  notes,
}: {
  propertyId: string
  /** null = the notes read failed */
  notes: PropertyNoteView[] | null
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<PropertyNoteKind>('access_form')
  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  // The upload that succeeded for `file` — reused if saving the note fails and
  // staff retry, so a retry doesn't store the same document twice.
  const [uploaded, setUploaded] = useState<{ file: File; path: string; type: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setAdding(false)
    setKind('access_form')
    setBody('')
    setFile(null)
    setUploaded(null)
    setError(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  function pickFile(picked: File | null) {
    setError(null)
    if (!picked) {
      setFile(null)
      return
    }
    const problem = checkDocumentFile({ type: resolveFileType(picked.name, picked.type), size: picked.size })
    if (problem) {
      setError(problem)
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      return
    }
    setFile(picked)
  }

  async function save() {
    setError(null)
    if (kind === 'access_form' && !file) {
      setError('Attach the signed permission-to-enter form.')
      return
    }
    if (!file && !body.trim()) {
      setError('Add a note or attach a file.')
      return
    }

    setSaving(true)
    try {
      let attachment: { path: string; name: string; type: string; size: number } | undefined
      if (file) {
        let stored = uploaded?.file === file ? uploaded : null
        if (!stored) {
          const type = resolveFileType(file.name, file.type)
          const ticket = await createPropertyDocumentUploadUrl({
            propertyId,
            fileName: file.name,
            fileType: type,
            fileSize: file.size,
          })
          if (!ticket.ok) {
            setError(ticket.error)
            return
          }
          const { error: uploadError } = await createClient()
            .storage.from(PROPERTY_DOCUMENTS_BUCKET)
            .uploadToSignedUrl(ticket.data.path, ticket.data.token, file, { contentType: type })
          if (uploadError) {
            setError(`Upload failed: ${uploadError.message}`)
            return
          }
          stored = { file, path: ticket.data.path, type }
          setUploaded(stored)
        }
        attachment = { path: stored.path, name: file.name.slice(0, 255), type: stored.type, size: file.size }
      }

      const result = await addPropertyNote({ propertyId, kind, body, file: attachment })
      if (!result.ok) {
        setError(result.error)
        return
      }
      reset()
      router.refresh()
    } catch (e) {
      setError(staleActionMessage(e) ?? 'Could not save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  async function remove(note: PropertyNoteView) {
    const what = note.kind === 'access_form' ? 'this permission-to-enter form' : 'this note'
    if (!window.confirm(`Remove ${what}? It will be hidden here but kept on record.`)) return
    setError(null)
    setRemovingId(note.id)
    try {
      const result = await removePropertyNote(note.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    } catch (e) {
      setError(staleActionMessage(e) ?? 'Could not remove. Please try again.')
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="rounded-xl bg-white shadow-sm">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="font-[family-name:var(--font-heading)] text-body font-bold text-[#293F52]">
          Notes &amp; documents
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-body-sm font-medium text-[#293F52] hover:bg-gray-50"
          >
            Add
          </button>
        )}
      </div>

      {error && !adding && (
        <div role="alert" className="mx-5 mb-3 rounded-lg bg-status-error-bg px-3 py-2 text-body-sm text-status-error">
          {error}
        </div>
      )}

      {adding && (
        <div className="space-y-3 border-t border-gray-100 px-5 py-4">
          <div>
            <FieldLabel htmlFor="property-note-kind">Type</FieldLabel>
            <Select
              id="property-note-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as PropertyNoteKind)}
            >
              <option value="access_form">Permission-to-enter form</option>
              <option value="note">Note</option>
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor="property-note-body">
              {kind === 'access_form' ? 'Details (optional)' : 'Note'}
            </FieldLabel>
            <Textarea
              id="property-note-body"
              rows={3}
              maxLength={PROPERTY_NOTE_BODY_MAX}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                kind === 'access_form'
                  ? 'e.g. Signed by the owner — collect from behind the side gate'
                  : 'e.g. Dog on property — call ahead'
              }
            />
          </div>
          <div>
            <FieldLabel htmlFor="property-note-file">
              {kind === 'access_form' ? 'Signed form' : 'File (optional)'}
            </FieldLabel>
            <input
              id="property-note-file"
              ref={fileInput}
              type="file"
              accept={PROPERTY_NOTE_ACCEPT}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              className="block w-full text-body-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-body-sm file:font-medium file:text-[#293F52] hover:file:bg-gray-200"
            />
            <p className="mt-1 text-xs text-gray-500">PDF or photo (JPEG, PNG, HEIC, WebP), up to 10 MB.</p>
          </div>

          {error && (
            <div role="alert" className="rounded-lg bg-status-error-bg px-3 py-2 text-body-sm text-status-error">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={saving}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-body-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-[#293F52] px-3 py-1.5 text-body-sm font-medium disabled:opacity-50"
              style={{ color: '#FFFFFF' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {notes === null ? (
        <p role="status" className="mx-5 mb-5 rounded-lg bg-status-warn-bg px-3 py-2 text-body-sm text-status-warn">
          Couldn&rsquo;t load notes and documents — refresh the page to try again.
        </p>
      ) : notes.length === 0 ? (
        !adding && <p className="px-5 pb-5 text-body-sm text-gray-500">No notes or documents yet.</p>
      ) : (
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
              <button
                type="button"
                onClick={() => remove(note)}
                disabled={removingId === note.id}
                className="shrink-0 text-xs font-medium text-status-error hover:underline disabled:opacity-50"
              >
                {removingId === note.id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
