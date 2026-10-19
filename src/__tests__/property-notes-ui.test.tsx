import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const uploadToSignedUrl = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: () => ({ uploadToSignedUrl }) } }),
}))
vi.mock('@/lib/supabase/invoke-ef-client', () => ({ invokeEfWithUserToken: vi.fn() }))

const addPropertyNote = vi.fn()
const createPropertyDocumentUploadUrl = vi.fn()
const removePropertyNote = vi.fn()
vi.mock('@/app/(admin)/admin/properties/[id]/property-notes-actions', () => ({
  addPropertyNote: (...a: unknown[]) => addPropertyNote(...a),
  createPropertyDocumentUploadUrl: (...a: unknown[]) => createPropertyDocumentUploadUrl(...a),
  removePropertyNote: (...a: unknown[]) => removePropertyNote(...a),
}))
vi.mock('@/app/(admin)/admin/bookings/[id]/actions', () => ({
  confirmBooking: vi.fn(),
  cancelBooking: vi.fn(),
  updateContact: vi.fn(),
  updateBookingQuantities: vi.fn(),
  updateNotes: vi.fn(),
  updateCollectionDetails: vi.fn(),
}))

import { PropertyNotesSection, type PropertyNoteView } from '@/app/(admin)/admin/properties/[id]/property-notes-section'
import { BookingDetailClient } from '@/app/(admin)/admin/bookings/[id]/booking-detail-client'

const PROPERTY = 'c67dd909-4b4e-4856-acf9-219a37dc7d0e'

const FORM: PropertyNoteView = {
  id: 'n-1',
  kind: 'access_form',
  body: 'Signed by owner — collect behind side gate',
  file_name: 'permission.pdf',
  file_size: 1.25 * 1024 * 1024,
  file_url: 'https://example.test/signed/permission.pdf',
  // 23:30 UTC on 12/10 is 07:30 AWST on 13/10 — the date shown must be Perth's.
  created_at: '2026-10-12T23:30:00.000Z',
  author_name: 'Kim Lenton',
}

beforeEach(() => {
  refresh.mockReset()
  uploadToSignedUrl.mockReset().mockResolvedValue({ data: { path: 'p' }, error: null })
  addPropertyNote.mockReset().mockResolvedValue({ ok: true, data: { id: 'new' } })
  createPropertyDocumentUploadUrl.mockReset().mockResolvedValue({ ok: true, data: { path: 'c/p/u-form.pdf', token: 't' } })
  removePropertyNote.mockReset().mockResolvedValue({ ok: true, data: { id: 'n-1' } })
})

describe('PropertyNotesSection', () => {
  it('lists an entry with its type, note, file link, author and Perth date', () => {
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[FORM]} />)
    expect(screen.getByText('Permission to enter')).toBeTruthy()
    expect(screen.getByText(FORM.body!)).toBeTruthy()
    const link = screen.getByRole('link', { name: /permission\.pdf/ })
    expect(link.getAttribute('href')).toBe(FORM.file_url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('1.3 MB')).toBeTruthy()
    expect(screen.getByText('Added by Kim Lenton · 13/10/2026')).toBeTruthy()
  })

  it('shows an empty state', () => {
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[]} />)
    expect(screen.getByText('No notes or documents yet.')).toBeTruthy()
  })

  it('will not save a permission-to-enter form without its file', async () => {
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText(/Details/), { target: { value: 'signed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Attach the signed/)
    expect(createPropertyDocumentUploadUrl).not.toHaveBeenCalled()
    expect(addPropertyNote).not.toHaveBeenCalled()
  })

  it('saves a plain note without uploading anything', async () => {
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'note' } })
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Dog on property' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(addPropertyNote).toHaveBeenCalledTimes(1))
    expect(addPropertyNote).toHaveBeenCalledWith({
      propertyId: PROPERTY,
      kind: 'note',
      body: 'Dog on property',
      file: undefined,
    })
    expect(createPropertyDocumentUploadUrl).not.toHaveBeenCalled()
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('uploads the form, then saves the note pointing at the uploaded path', async () => {
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const pdf = new File(['%PDF'], 'form.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Signed form'), { target: { files: [pdf] } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(addPropertyNote).toHaveBeenCalledTimes(1))
    expect(createPropertyDocumentUploadUrl).toHaveBeenCalledWith({
      propertyId: PROPERTY,
      fileName: 'form.pdf',
      fileType: 'application/pdf',
      fileSize: 4,
    })
    expect(uploadToSignedUrl).toHaveBeenCalledWith('c/p/u-form.pdf', 't', pdf, { contentType: 'application/pdf' })
    expect(addPropertyNote.mock.calls[0]![0]).toMatchObject({
      kind: 'access_form',
      file: { path: 'c/p/u-form.pdf', name: 'form.pdf', type: 'application/pdf', size: 4 },
    })
  })

  it('does not save the note when the upload fails', async () => {
    uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: 'boom' } })
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const pdf = new File(['%PDF'], 'form.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Signed form'), { target: { files: [pdf] } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Upload failed: boom/)
    expect(addPropertyNote).not.toHaveBeenCalled()
  })

  it('a failed notes load says so — never "no notes" (that reads as "no form on file")', () => {
    render(<PropertyNotesSection propertyId={PROPERTY} notes={null} />)
    expect(screen.getByRole('status').textContent).toMatch(/Couldn.t load notes/)
    expect(screen.queryByText('No notes or documents yet.')).toBeNull()
  })

  it('a retry after a failed save reuses the uploaded file instead of storing it twice', async () => {
    addPropertyNote.mockResolvedValueOnce({ ok: false, error: 'Service error. Please try again.' })
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const pdf = new File(['%PDF'], 'form.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Signed form'), { target: { files: [pdf] } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Service error/)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(addPropertyNote).toHaveBeenCalledTimes(2))
    expect(uploadToSignedUrl).toHaveBeenCalledTimes(1)
    expect(createPropertyDocumentUploadUrl).toHaveBeenCalledTimes(1)
    expect(addPropertyNote.mock.calls[1]![0]).toMatchObject({ file: { path: 'c/p/u-form.pdf' } })
  })

  it('rejects a disallowed file type before uploading', () => {
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const doc = new File(['x'], 'form.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    fireEvent.change(screen.getByLabelText('Signed form'), { target: { files: [doc] } })
    expect(screen.getByRole('alert').textContent).toMatch(/PDF or a photo/)
  })

  it('removes only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(<PropertyNotesSection propertyId={PROPERTY} notes={[FORM]} />)

    confirm.mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removePropertyNote).not.toHaveBeenCalled()

    confirm.mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(removePropertyNote).toHaveBeenCalledWith('n-1'))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    confirm.mockRestore()
  })
})

describe('admin booking page — property notes banner', () => {
  type Booking = ComponentProps<typeof BookingDetailClient>['booking']
  const booking = {
    id: 'booking-uuid',
    ref: 'KWN-2026-000123',
    status: 'Confirmed',
    type: 'Residential',
    location: 'Front Verge',
    notes: null,
    created_at: '2026-07-01T01:00:00.000Z',
    updated_at: '2026-07-01T01:00:00.000Z',
    property_id: PROPERTY,
    collection_area_id: 'area-uuid',
    contact_id: 'contact-uuid',
    client_id: 'client-uuid',
    latitude: null,
    longitude: null,
    geo_address: null,
    photos: [],
    id_waste_types: [],
    id_volume: null,
    collection_area: { name: 'KWN-1', code: 'KWN-1' },
    eligible_properties: { formatted_address: '23 Leda Blvd, Wellard WA 6170', address: '23 Leda Blvd', latitude: -32.2, longitude: 115.8 },
    contact: { first_name: 'Jo', last_name: 'Bloggs', full_name: 'Jo Bloggs', mobile_e164: '+61412345678', email: 'jo@example.com' },
    booking_item: [],
  } as unknown as Booking

  function renderBooking(summary: string | null) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <BookingDetailClient
          booking={booking}
          auditLogs={[]}
          mudContext={null}
          userRole="contractor-admin"
          exceptions={[]}
          tickets={[]}
          propertyNotesSummary={summary}
        />
      </QueryClientProvider>,
    )
  }

  it('links to the property when a form is on file', () => {
    renderBooking('Permission-to-enter form on file')
    const link = screen.getByRole('link', { name: /Permission-to-enter form on file/ })
    expect(link.getAttribute('href')).toBe(`/admin/properties/${PROPERTY}`)
  })

  it('shows nothing when the property has no notes', () => {
    renderBooking(null)
    expect(screen.queryByText(/on file/)).toBeNull()
  })
})
