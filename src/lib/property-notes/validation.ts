import { z } from 'zod'

/**
 * Property notes & documents (ADR 0031) — shared rules for the server actions
 * and the upload form. The database (CHECKs, RLS, bucket limits in migration
 * 20261013180000) is the authority; these mirror it so staff get a clear
 * message before an upload instead of a storage error after it.
 */

export const PROPERTY_DOCUMENTS_BUCKET = 'property-documents'

export const PROPERTY_NOTE_MAX_BYTES = 10 * 1024 * 1024
export const PROPERTY_NOTE_BODY_MAX = 2000

export const PROPERTY_NOTE_ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const

export const PROPERTY_NOTE_ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.heic,.webp,' + PROPERTY_NOTE_ALLOWED_TYPES.join(',')

export const PROPERTY_NOTE_KINDS = ['access_form', 'note'] as const
export type PropertyNoteKind = (typeof PROPERTY_NOTE_KINDS)[number]

export const PROPERTY_NOTE_KIND_LABELS: Record<PropertyNoteKind, string> = {
  access_form: 'Permission to enter',
  note: 'Note',
}

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
}

/** Storage-safe file name: no path separators, no leading dots, ≤120 chars. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120)
  return cleaned || 'file'
}

/** Object path: <client_id>/<property_id>/<uuid>-<file name>. */
export function buildDocumentPath(
  clientId: string,
  propertyId: string,
  fileName: string,
  uuid: string,
): string {
  return `${clientId}/${propertyId}/${uuid}-${safeFileName(fileName)}`
}

/** True when `path` is a single file directly under this property's folder. */
export function isPathForProperty(path: string, clientId: string, propertyId: string): boolean {
  const prefix = `${clientId}/${propertyId}/`
  if (!path.startsWith(prefix)) return false
  const rest = path.slice(prefix.length)
  return rest.length > 0 && !rest.includes('/') && !rest.startsWith('.')
}

/** Browsers report no type for some files (HEIC on Chrome) — fall back to the extension. */
export function resolveFileType(name: string, type: string): string {
  if (type) return type
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_TYPES[ext] ?? ''
}

/** Null when the file is acceptable, else a message for staff. */
export function checkDocumentFile(file: { type: string; size: number }): string | null {
  if (!(PROPERTY_NOTE_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    return 'Upload a PDF or a photo (JPEG, PNG, HEIC or WebP).'
  }
  if (file.size <= 0) return 'That file is empty.'
  if (file.size > PROPERTY_NOTE_MAX_BYTES) return 'Files must be 10 MB or smaller.'
  return null
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Booking-page banner text for the active entries on a property, or null. */
export function summariseNotes(kinds: string[]): string | null {
  if (kinds.length === 0) return null
  if (kinds.includes('access_form')) return 'Permission-to-enter form on file'
  return kinds.length === 1 ? '1 property note on file' : `${kinds.length} property notes on file`
}

// ── Schemas ─────────────────────────────────────────────────────────────

const fileTypeSchema = z.enum(PROPERTY_NOTE_ALLOWED_TYPES)

export const uploadRequestSchema = z.object({
  propertyId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  fileType: fileTypeSchema,
  fileSize: z.number().int().positive().max(PROPERTY_NOTE_MAX_BYTES),
})

export const addPropertyNoteSchema = z
  .object({
    propertyId: z.string().uuid(),
    kind: z.enum(PROPERTY_NOTE_KINDS),
    body: z
      .string()
      .trim()
      .max(PROPERTY_NOTE_BODY_MAX)
      .optional()
      .transform((v) => (v ? v : undefined)),
    file: z
      .object({
        path: z.string().min(1),
        name: z.string().min(1).max(255),
        type: fileTypeSchema,
        size: z.number().int().positive().max(PROPERTY_NOTE_MAX_BYTES),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.body && !v.file) {
      ctx.addIssue({ code: 'custom', message: 'Add a note or attach a file.' })
    }
    if (v.kind === 'access_form' && !v.file) {
      ctx.addIssue({ code: 'custom', message: 'Attach the signed permission-to-enter form.' })
    }
  })

/** Caller-side shape; addPropertyNoteSchema validates it on the server. */
export interface AddPropertyNoteInput {
  propertyId: string
  kind: string
  body?: string
  file?: { path: string; name: string; type: string; size: number }
}
