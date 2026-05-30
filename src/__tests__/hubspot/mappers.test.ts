import { describe, it, expect } from 'vitest'
import {
  mapContactToHubspot,
  mapBookingToOrder,
  mapTicketToHubspotTicket,
  vercoDeeplink,
} from '@/lib/hubspot/mappers'
import type { VercoBookingInput, VercoContactInput, VercoTicketInput } from '@/lib/hubspot/types'

const opts = { vercoBaseUrl: 'https://app.verco.au' }

describe('vercoDeeplink', () => {
  it('builds /admin/<entity>/<id>', () => {
    expect(vercoDeeplink('https://app.verco.au', 'bookings', 'b1')).toBe('https://app.verco.au/admin/bookings/b1')
    expect(vercoDeeplink('https://app.verco.au', 'service-tickets', 't1')).toBe(
      'https://app.verco.au/admin/service-tickets/t1',
    )
  })
  it('tolerates a trailing slash on the base URL', () => {
    expect(vercoDeeplink('https://app.verco.au/', 'bookings', 'b1')).toBe('https://app.verco.au/admin/bookings/b1')
  })
})

describe('mapContactToHubspot', () => {
  const base: VercoContactInput = {
    id: 'c1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    mobile_e164: '+61400000000',
  }

  it('upserts by email with verco_contact_id + name + phone', () => {
    const rec = mapContactToHubspot(base, opts)
    expect(rec).not.toBeNull()
    expect(rec!.idProperty).toBe('email')
    expect(rec!.id).toBe('ada@example.com')
    expect(rec!.properties).toEqual({
      email: 'ada@example.com',
      verco_contact_id: 'c1',
      firstname: 'Ada',
      lastname: 'Lovelace',
      phone: '+61400000000',
    })
  })

  it('returns null when the contact has no email (Issue 2 — never upsert with a null dedupe key)', () => {
    expect(mapContactToHubspot({ ...base, email: null }, opts)).toBeNull()
    expect(mapContactToHubspot({ ...base, email: '' }, opts)).toBeNull()
  })

  it('omits absent optional fields rather than sending empty strings', () => {
    const rec = mapContactToHubspot({ ...base, first_name: null, last_name: null, mobile_e164: null }, opts)
    expect(rec!.properties).toEqual({ email: 'ada@example.com', verco_contact_id: 'c1' })
  })

  it('sets no verco_url deeplink (no /admin/contacts page — TD1)', () => {
    const rec = mapContactToHubspot(base, opts)
    expect(rec!.properties.verco_url).toBeUndefined()
  })
})

describe('mapBookingToOrder', () => {
  const base: VercoBookingInput = {
    id: 'bk1',
    ref: 'KWN-21777',
    status: 'Confirmed',
    collection_date: '2026-06-15',
    address: '23 Leda Blvd, Wellard',
  }

  it('keys on native hs_external_order_id and maps ref/status/url/date/address', () => {
    const rec = mapBookingToOrder(base, opts)
    expect(rec.idProperty).toBe('hs_external_order_id')
    expect(rec.id).toBe('bk1')
    expect(rec.properties).toEqual({
      hs_external_order_id: 'bk1',
      hs_order_name: 'KWN-21777',
      hs_external_order_status: 'Confirmed',
      hs_external_order_url: 'https://app.verco.au/admin/bookings/bk1',
      collection_date: '2026-06-15',
      address: '23 Leda Blvd, Wellard',
    })
  })

  it('NEVER sets amount (TD2 — USD account, AUD values)', () => {
    const rec = mapBookingToOrder(base, opts)
    expect(rec.properties.amount).toBeUndefined()
    expect(rec.properties.hs_total_price).toBeUndefined()
  })

  it('omits collection_date and address when absent', () => {
    const rec = mapBookingToOrder({ ...base, collection_date: null, address: null }, opts)
    expect(rec.properties.collection_date).toBeUndefined()
    expect(rec.properties.address).toBeUndefined()
    // required fields still present
    expect(rec.properties.hs_order_name).toBe('KWN-21777')
  })

  it('keeps collection_date date-only (no timezone, no off-by-one — F5)', () => {
    const rec = mapBookingToOrder(base, opts)
    expect(rec.properties.collection_date).toBe('2026-06-15')
    expect(rec.properties.collection_date).not.toMatch(/T|Z|:/)
  })
})

describe('mapTicketToHubspotTicket', () => {
  const base: VercoTicketInput = {
    id: 't1',
    subject: 'Bin not collected',
    message: 'My green bin was skipped',
    category: 'missed_collection',
    status: 'in_progress',
    phone_number: '+61400111222',
    created_at: '2026-05-01T00:00:00.000Z',
    closed_at: '2026-05-01T02:00:00.000Z',
    booking_ref: 'KWN-21777',
  }

  it('keys on verco_ticket_id and maps the REAL columns (content←message, query_type←category)', () => {
    const rec = mapTicketToHubspotTicket(base, opts)
    expect(rec.idProperty).toBe('verco_ticket_id')
    expect(rec.id).toBe('t1')
    expect(rec.properties).toMatchObject({
      verco_ticket_id: 't1',
      subject: 'Bin not collected',
      content: 'My green bin was skipped',
      query_type: 'missed_collection',
      hs_pipeline: '0',
      hs_pipeline_stage: '3', // in_progress → Waiting on us
      verco_url: 'https://app.verco.au/admin/service-tickets/t1',
      phone_number: '+61400111222',
      booking_ref: 'KWN-21777',
    })
  })

  it('computes time_to_close in ms (closed_at − created_at)', () => {
    const rec = mapTicketToHubspotTicket(base, opts)
    expect(rec.properties.time_to_close).toBe(String(2 * 60 * 60 * 1000))
  })

  it('omits time_to_close while the ticket is open, and omits absent phone/booking_ref', () => {
    const rec = mapTicketToHubspotTicket(
      { ...base, status: 'open', closed_at: null, phone_number: null, booking_ref: null },
      opts,
    )
    expect(rec.properties.time_to_close).toBeUndefined()
    expect(rec.properties.phone_number).toBeUndefined()
    expect(rec.properties.booking_ref).toBeUndefined()
    expect(rec.properties.hs_pipeline_stage).toBe('1') // open → New
  })

  it('omits time_to_close on malformed or inverted timestamps (no negative/NaN durations)', () => {
    expect(mapTicketToHubspotTicket({ ...base, closed_at: 'not-a-date' }, opts).properties.time_to_close).toBeUndefined()
    expect(
      mapTicketToHubspotTicket({ ...base, created_at: '2026-05-01T05:00:00.000Z' }, opts).properties.time_to_close,
    ).toBeUndefined() // closed before created
  })
})
