// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { CallerLookupView } from '@/app/(admin)/admin/lookup/caller-lookup-view'
import type { CallerMatch } from '@/app/(admin)/admin/lookup/caller-matches'

/**
 * What Kim sees when a Teams call pops /admin/lookup (VER-316): the caller's
 * contact(s) with bookings and tickets, or a clear way forward on a miss.
 */

const alex: CallerMatch = {
  contact: { id: 'c-a', fullName: 'Alex Able', mobile: '+61412345678', email: 'a@example.com' },
  bookings: [
    { id: 'b-uuid', ref: 'VV-COT-2', status: 'Confirmed', areaCode: 'VV-COT', collectionDates: ['2026-11-02'], address: '1 Test St, Cottesloe' },
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

describe('CallerLookupView', () => {
  it('shows the caller with links to their booking (by id) and ticket (by display id)', () => {
    render(<CallerLookupView query="+61412345678" candidates={['+61412345678']} result={{ ok: true, data: [alex] }} />)

    expect(screen.getByRole('heading', { name: 'Alex Able' })).toBeTruthy()
    expect(screen.getAllByText(/0412 345 678/).length).toBeGreaterThan(0)
    expect(screen.getByText('a@example.com')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'VV-COT-2' }).getAttribute('href')).toBe('/admin/bookings/b-uuid')
    expect(screen.getByRole('link', { name: /TKT-1001/ }).getAttribute('href')).toBe('/admin/service-tickets/TKT-1001')
    expect(screen.getByText('Mon 2 Nov 2026')).toBeTruthy()
    expect(screen.getByText('1 Test St, Cottesloe')).toBeTruthy()
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
})
