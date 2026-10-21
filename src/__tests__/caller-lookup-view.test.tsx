// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { CallerLookupView } from '@/app/(admin)/admin/lookup/caller-lookup-view'
import type { CallerMatch } from '@/app/(admin)/admin/lookup/caller-matches'
import type { PropertyNoteView } from '@/lib/property-notes/load'

// The cross-council "Add a note" is a client component calling a server action.
vi.mock('@/app/(admin)/admin/lookup/add-note-in-council', () => ({
  AddNoteInCouncil: ({ clientName }: { clientName: string }) => <button type="button">Add a note in {clientName}</button>,
}))

/**
 * What Kim sees when a Teams call pops /admin/lookup (VER-316): the caller's
 * contact(s) with bookings and tickets, or a clear way forward on a miss.
 */

const alex: CallerMatch = {
  contact: { id: 'c-a', fullName: 'Alex Able', mobile: '+61412345678', email: 'a@example.com' },
  bookings: [
    { id: 'b-uuid', ref: 'VV-COT-2', status: 'Confirmed', areaCode: 'VV-COT', collectionDates: ['2026-11-02'], address: '1 Test St, Cottesloe', propertyId: 'p-1', clientId: 'vv' },
  ],
  tickets: [
    { id: 't-uuid', displayId: 'TKT-1001', subject: 'Missed pickup', status: 'open', createdAt: '2026-10-01T02:00:00Z' },
  ],
}
const bo: CallerMatch = {
  contact: { id: 'c-b', fullName: 'Bo Baker', mobile: '+61412345678', email: 'bo@example.com' },
  bookings: [],
  tickets: [],
}

const gateNote: PropertyNoteView = {
  id: 'n-1',
  property_id: 'p-1',
  kind: 'note',
  body: 'Side gate code 1234 — dog in yard',
  file_name: null,
  file_size: null,
  file_url: null,
  created_at: '2026-10-20T01:00:00.000Z',
  author_name: 'Staff One',
}

describe('CallerLookupView', () => {
  it('shows the caller with links to their booking (by id) and ticket (by display id)', () => {
    render(<CallerLookupView query="+61412345678" candidates={['+61412345678']} result={{ ok: true, data: [alex] }} />)

    expect(screen.getByRole('heading', { name: 'Alex Able' })).toBeTruthy()
    expect(screen.getAllByText(/0412 345 678/).length).toBeGreaterThan(0)
    expect(screen.getByText('a@example.com')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'VV-COT-2' }).getAttribute('href')).toBe('/admin/bookings/b-uuid')
    expect(screen.getByRole('link', { name: /TKT-1001/ }).getAttribute('href')).toBe('/admin/service-tickets/TKT-1001')
    expect(screen.getByText('Mon 2 Nov 2026')).toBeTruthy()
    expect(within(screen.getByRole('table')).getByText('1 Test St, Cottesloe')).toBeTruthy()
  })

  it('lists every contact on a shared number and says so', () => {
    render(<CallerLookupView query="+61412345678" candidates={['+61412345678']} result={{ ok: true, data: [alex, bo] }} />)

    expect(screen.getByRole('heading', { name: 'Alex Able' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Bo Baker' })).toBeTruthy()
    expect(screen.getByText(/2 contacts share this number/i)).toBeTruthy()
  })

  it('on a miss, names the number and hands off to booking search and a new booking', () => {
    render(<CallerLookupView query=" 61412345678" candidates={['+61412345678']} result={{ ok: true, data: [] }} />)

    expect(screen.getByText('No Verco contact for 0412 345 678')).toBeTruthy()
    const search = screen.getByRole('search', { name: /search bookings/i })
    expect(search.getAttribute('action')).toBe('/admin/bookings')
    expect(within(search).getByRole('searchbox').getAttribute('name')).toBe('search')
    expect(screen.getByRole('link', { name: /new booking/i }).getAttribute('href')).toBe('/book?on_behalf=true')
  })

  // /book on the admin host books under the switcher's council, whatever the
  // caller's council is, so the link says which one it will use.
  it('on a miss, names the council a new booking will be made under', () => {
    render(
      <CallerLookupView
        query="+61412345678"
        candidates={['+61412345678']}
        result={{ ok: true, data: [] }}
        newBookingClientName="City of Kwinana"
      />,
    )

    expect(screen.getByRole('link', { name: /new booking/i }).textContent).toContain('City of Kwinana')
  })

  it('shows a failed lookup as an error, never as "no contact"', () => {
    render(<CallerLookupView query="+61412345678" candidates={['+61412345678']} result={{ ok: false, error: "Couldn't search contacts: statement timeout" }} />)

    expect(screen.getByRole('alert').textContent).toContain('statement timeout')
    expect(screen.queryByText(/No Verco contact/)).toBeNull()
  })

  it('tells staff when the value is not a phone number', () => {
    render(<CallerLookupView query="{phone}" candidates={[]} result={null} />)

    expect(screen.getByText(/isn.t a phone number/i)).toBeTruthy()
    expect(screen.queryByText(/No Verco contact/)).toBeNull()
  })

  it('always offers a phone search box that reloads the lookup', () => {
    render(<CallerLookupView query="" candidates={[]} result={null} />)

    const form = screen.getByRole('search', { name: /look up a caller/i })
    expect(form.getAttribute('action')).toBe('/admin/lookup')
    expect(within(form).getByRole('searchbox').getAttribute('name')).toBe('phone')
  })

  // VER-321: access notes (gate code, dog, call ahead) under the caller, per
  // property on their bookings, with a way to add one.
  describe('property notes', () => {
    const render1 = (
      propertyNotes: PropertyNoteView[] | null,
      match: CallerMatch = alex,
      currentClientId: string | null = 'vv',
    ) =>
      render(
        <CallerLookupView
          query="+61412345678"
          candidates={['+61412345678']}
          result={{ ok: true, data: [match] }}
          propertyNotes={propertyNotes}
          currentClientId={currentClientId}
          clientNames={{ vv: 'Verge Valet', kwn: 'City of Kwinana' }}
        />,
      )

    it('shows each property’s notes and links to the property to add one', () => {
      render1([gateNote])

      const notes = screen.getByRole('region', { name: /property notes/i })
      expect(within(notes).getByText('1 Test St, Cottesloe')).toBeTruthy()
      expect(within(notes).getByText('Side gate code 1234 — dog in yard')).toBeTruthy()
      expect(within(notes).getByText(/Added by Staff One/)).toBeTruthy()
      expect(within(notes).getByRole('link', { name: /add a note/i }).getAttribute('href')).toBe('/admin/properties/p-1')
      // Read-only here: removing an entry stays on the property page.
      expect(within(notes).queryByRole('button', { name: /remove/i })).toBeNull()
    })

    // The property page opens only properties in the switcher's council.
    it('in another council, offers to switch there instead of a dead link', () => {
      render1([gateNote], alex, 'kwn')

      const notes = screen.getByRole('region', { name: /property notes/i })
      expect(within(notes).queryByRole('link', { name: /add a note/i })).toBeNull()
      expect(within(notes).getByRole('button', { name: /add a note in verge valet/i })).toBeTruthy()
    })

    it('says when a property has no notes, and still links to add one', () => {
      render1([])

      const notes = screen.getByRole('region', { name: /property notes/i })
      expect(within(notes).getByText(/no notes/i)).toBeTruthy()
      expect(within(notes).getByRole('link', { name: /add a note/i }).getAttribute('href')).toBe('/admin/properties/p-1')
    })

    it('shows a failed notes read as a warning, never as "no notes"', () => {
      render1(null)

      const notes = screen.getByRole('region', { name: /property notes/i })
      expect(within(notes).getByRole('status').textContent).toMatch(/couldn.t load/i)
      expect(within(notes).queryByText(/no notes/i)).toBeNull()
    })

    it('lists a property once even when several bookings are at it', () => {
      const twice: CallerMatch = {
        ...alex,
        bookings: [alex.bookings[0]!, { ...alex.bookings[0]!, id: 'b-2', ref: 'VV-COT-3' }],
      }
      render1([gateNote], twice)

      expect(screen.getAllByText('Side gate code 1234 — dog in yard')).toHaveLength(1)
    })

    it('has no notes block when no booking is at a property', () => {
      render1([], { ...alex, bookings: [{ ...alex.bookings[0]!, propertyId: null }] })

      expect(screen.queryByRole('region', { name: /property notes/i })).toBeNull()
    })
  })
})
