import { describe, it, expect } from 'vitest'
import { planNoteBackfill, type NoteBackfillBooking } from '../lib/note-backfill'
import type { SourceBooking } from '../lib/reconcile'

function booking(overrides: Partial<NoteBackfillBooking> = {}): NoteBackfillBooking {
  return {
    id: 'v1',
    ref: 'COT-100',
    area: 'COT',
    notes: null,
    propertyExternalId: 'recProp1',
    collectionDate: '2026-07-08',
    ...overrides,
  }
}

function source(overrides: Partial<SourceBooking> = {}): SourceBooking {
  return {
    recordId: 'recBk1',
    bookingRef: 'COT-57000',
    propertyRecId: 'recProp1',
    collectionDate: '2026-07-08',
    status: 'Completed',
    noBulk: 1,
    noGreen: 0,
    noMattress: 0,
    wasteLocation: 'Front Verge',
    wasteNotes: 'Place on the verge opposite the corner',
    modifiedAt: '2026-06-22T00:00:00Z',
    ...overrides,
  }
}

describe('planNoteBackfill', () => {
  it('fills from a same-property, same-date master row (the reported case)', () => {
    const p = planNoteBackfill([booking()], [source()])
    expect(p.fills).toHaveLength(1)
    expect(p.fills[0]).toMatchObject({
      bookingId: 'v1',
      ref: 'COT-100',
      sourceRef: 'COT-57000',
      note: 'Place on the verge opposite the corner',
    })
  })

  it('trims surrounding whitespace on the carried note', () => {
    const p = planNoteBackfill([booking()], [source({ wasteNotes: '\n  padded note  \n' })])
    expect(p.fills[0]!.note).toBe('padded note')
  })

  it('skips bookings that already carry notes (idempotent)', () => {
    const p = planNoteBackfill([booking({ notes: 'crew already knows' })], [source()])
    expect(p.fills).toHaveLength(0)
    expect(p.alreadyHasNotes).toBe(1)
  })

  it('does not fill when the master row has a blank note', () => {
    const p = planNoteBackfill([booking()], [source({ wasteNotes: '   ' })])
    expect(p.fills).toHaveLength(0)
    expect(p.noSourceNote).toBe(1)
  })

  it('cannot match a booking with no property external id', () => {
    const p = planNoteBackfill([booking({ propertyExternalId: null })], [source()])
    expect(p.fills).toHaveLength(0)
    expect(p.noProperty).toBe(1)
  })

  it('does NOT fill from a note on a different round — surfaces it as other-round only', () => {
    const b = booking({ collectionDate: '2026-09-01' }) // no same-date master row
    const s = source({ collectionDate: '2025-02-08', bookingRef: 'COT-11547', wasteNotes: 'Green and Bulk Waste' })
    const p = planNoteBackfill([b], [s])
    expect(p.fills).toHaveLength(0)
    expect(p.otherDateOnly).toHaveLength(1)
    expect(p.otherDateOnly[0]).toMatchObject({ ref: 'COT-100', note: 'Green and Bulk Waste', sourceDate: '2025-02-08', sourceRef: 'COT-11547' })
  })

  it('prefers the same-date row even when other-date notes exist for the property', () => {
    const b = booking({ collectionDate: '2026-07-08' })
    const same = source({ recordId: 'a', bookingRef: 'COT-SAME', collectionDate: '2026-07-08', wasteNotes: 'This round instructions' })
    const other = source({ recordId: 'b', bookingRef: 'COT-OLD', collectionDate: '2025-07-08', wasteNotes: 'Old instructions' })
    const p = planNoteBackfill([b], [same, other])
    expect(p.fills).toHaveLength(1)
    expect(p.fills[0]).toMatchObject({ note: 'This round instructions', sourceRef: 'COT-SAME' })
    expect(p.otherDateOnly).toHaveLength(0)
  })

  it('picks the most recently modified row among multiple same-date matches', () => {
    const b = booking({ collectionDate: '2026-07-08' })
    const older = source({ recordId: 'a', bookingRef: 'COT-OLD', wasteNotes: 'stale', modifiedAt: '2026-06-01T00:00:00Z' })
    const newer = source({ recordId: 'b', bookingRef: 'COT-NEW', wasteNotes: 'fresh', modifiedAt: '2026-07-01T00:00:00Z' })
    const p = planNoteBackfill([b], [older, newer])
    expect(p.fills[0]).toMatchObject({ note: 'fresh', sourceRef: 'COT-NEW' })
  })
})
