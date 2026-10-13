import { describe, it, expect } from 'vitest'
import {
  PROPERTY_NOTE_MAX_BYTES,
  addPropertyNoteSchema,
  buildDocumentPath,
  checkDocumentFile,
  formatFileSize,
  isPathForProperty,
  resolveFileType,
  safeFileName,
  summariseNotes,
} from '@/lib/property-notes/validation'

const CLIENT = '5215645f-ca8f-4cff-8b7d-d5a8f7991ec7'
const PROPERTY = 'c67dd909-4b4e-4856-acf9-219a37dc7d0e'
const OTHER_PROPERTY = '4c89657c-759a-4172-adf7-d1dca4940230'
const FILE = {
  path: `${CLIENT}/${PROPERTY}/abc-form.pdf`,
  name: 'form.pdf',
  type: 'application/pdf',
  size: 1000,
}

describe('safeFileName', () => {
  it('replaces anything outside word chars, dot and dash', () => {
    expect(safeFileName('Permission to enter (signed).pdf')).toBe('Permission_to_enter_signed_.pdf')
  })

  it('strips path separators so a name can never add a folder', () => {
    expect(safeFileName('../../etc/passwd')).not.toContain('/')
    expect(safeFileName('..\\x.pdf')).not.toContain('\\')
  })

  it('never starts with a dot and falls back when nothing is left', () => {
    expect(safeFileName('...pdf')).toBe('pdf')
    expect(safeFileName('///')).toBe('file')
  })

  it('caps length at 120', () => {
    expect(safeFileName('a'.repeat(300) + '.pdf')).toHaveLength(120)
  })
})

describe('buildDocumentPath / isPathForProperty', () => {
  it('builds <client>/<property>/<uuid>-<name>', () => {
    expect(buildDocumentPath(CLIENT, PROPERTY, 'My Form.pdf', 'u1')).toBe(
      `${CLIENT}/${PROPERTY}/u1-My_Form.pdf`,
    )
  })

  it('accepts only a single file directly under the property folder', () => {
    expect(isPathForProperty(`${CLIENT}/${PROPERTY}/u1-a.pdf`, CLIENT, PROPERTY)).toBe(true)
    expect(isPathForProperty(`${CLIENT}/${OTHER_PROPERTY}/u1-a.pdf`, CLIENT, PROPERTY)).toBe(false)
    expect(isPathForProperty(`${CLIENT}/${PROPERTY}/sub/u1-a.pdf`, CLIENT, PROPERTY)).toBe(false)
    expect(isPathForProperty(`${CLIENT}/${PROPERTY}/`, CLIENT, PROPERTY)).toBe(false)
    expect(isPathForProperty(`${CLIENT}/${PROPERTY}/../x.pdf`, CLIENT, PROPERTY)).toBe(false)
  })
})

describe('resolveFileType', () => {
  it('keeps the browser-reported type', () => {
    expect(resolveFileType('a.pdf', 'application/pdf')).toBe('application/pdf')
  })

  it('infers from the extension when the browser reports nothing (HEIC on Chrome)', () => {
    expect(resolveFileType('IMG_0001.HEIC', '')).toBe('image/heic')
    expect(resolveFileType('scan.jpg', '')).toBe('image/jpeg')
    expect(resolveFileType('notes.docx', '')).toBe('')
  })
})

describe('checkDocumentFile', () => {
  it('accepts an allowed type within the size limit', () => {
    expect(checkDocumentFile({ type: 'image/heic', size: 5 })).toBeNull()
  })

  it('rejects other types', () => {
    expect(checkDocumentFile({ type: 'application/msword', size: 5 })).toMatch(/PDF/)
  })

  it('rejects empty and oversize files', () => {
    expect(checkDocumentFile({ type: 'application/pdf', size: 0 })).toMatch(/empty/)
    expect(checkDocumentFile({ type: 'application/pdf', size: PROPERTY_NOTE_MAX_BYTES + 1 })).toMatch(/10 MB/)
    expect(checkDocumentFile({ type: 'application/pdf', size: PROPERTY_NOTE_MAX_BYTES })).toBeNull()
  })
})

describe('addPropertyNoteSchema', () => {
  it('accepts a note with only a body (trimmed)', () => {
    const r = addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'note', body: '  Side gate  ' })
    expect(r.success).toBe(true)
    expect(r.success && r.data.body).toBe('Side gate')
  })

  it('accepts a note with only a file', () => {
    expect(addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'note', file: FILE }).success).toBe(true)
  })

  it('rejects a note with neither body nor file (blank body counts as none)', () => {
    const r = addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'note', body: '   ' })
    expect(r.success).toBe(false)
  })

  it('rejects a permission-to-enter form without its file', () => {
    const r = addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'access_form', body: 'signed' })
    expect(r.success).toBe(false)
  })

  it('accepts a permission-to-enter form with a file and optional body', () => {
    const r = addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'access_form', body: 'Owner J. Smith', file: FILE })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown kind, an over-long body and a disallowed file type', () => {
    expect(addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'other', body: 'x' }).success).toBe(false)
    expect(addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'note', body: 'x'.repeat(2001) }).success).toBe(false)
    expect(
      addPropertyNoteSchema.safeParse({ propertyId: PROPERTY, kind: 'note', file: { ...FILE, type: 'text/html' } }).success,
    ).toBe(false)
  })
})

describe('formatFileSize', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatFileSize(900)).toBe('900 B')
    expect(formatFileSize(350 * 1024)).toBe('350 KB')
    expect(formatFileSize(1.25 * 1024 * 1024)).toBe('1.3 MB')
  })
})

describe('summariseNotes', () => {
  it('leads with the permission-to-enter form when one is on file', () => {
    expect(summariseNotes(['note', 'access_form', 'note'])).toBe('Permission-to-enter form on file')
  })

  it('counts plain notes', () => {
    expect(summariseNotes(['note'])).toBe('1 property note on file')
    expect(summariseNotes(['note', 'note'])).toBe('2 property notes on file')
  })

  it('returns null when there is nothing on file', () => {
    expect(summariseNotes([])).toBeNull()
  })
})
