import { describe, expect, it } from 'vitest'
import type { ErrorEvent } from '@sentry/nextjs'

import {
  scrubBreadcrumb,
  scrubEvent,
  scrubTransaction,
  type TransactionEvent,
} from '@/lib/sentry/scrub'

// The booking wizard carries the resident's address (and, on a staff edit,
// their name, email, mobile and driver notes) in the URL query at every step.
// Those URLs reach Sentry in breadcrumbs, `request.url` and span attributes —
// none of these fixture values may survive the scrub.
const PROPERTY_ID = 'aaaaaaaa-1234-4567-8901-bbbbbbbbbbbb'
const AREA_ID = 'cccccccc-2345-4678-9012-dddddddddddd'
const SERVICE_ID = 'eeeeeeee-3456-4789-0123-ffffffffffff'
const PII = [
  '7 Fixture Way',
  'Fixture',
  'Testville',
  'Pat',
  'pat@example.com',
  'pat%40example.com',
  '61400000000',
  'Gate code',
]

function wizardQuery(): string {
  return new URLSearchParams({
    property_id: PROPERTY_ID,
    collection_area_id: AREA_ID,
    address: '7 Fixture Way, Testville WA 6000',
    on_behalf: 'true',
    items: `${SERVICE_ID}:2`,
    total_cents: '4500',
    contact_first_name: 'Pat',
    contact_last_name: 'Fixture',
    contact_email: 'pat@example.com',
    contact_mobile: '+61400000000',
    notes: 'Gate code 4321 behind the shed',
    date_from: '2030-01-02',
  }).toString()
}

function expectNoPii(value: unknown) {
  const json = JSON.stringify(value)
  for (const pii of PII) expect(json).not.toContain(pii)
}

function expectStructureKept(value: unknown) {
  const json = JSON.stringify(value)
  expect(json).toContain(`property_id=${PROPERTY_ID}`)
  expect(json).toContain(`collection_area_id=${AREA_ID}`)
  expect(json).toContain('on_behalf=true')
  expect(json).toContain('total_cents=4500')
  expect(json).toContain('date_from=2030-01-02')
  expect(json).toContain('address=[redacted]')
}

describe('scrubBreadcrumb — wizard URLs', () => {
  it('redacts free-text query values in navigation from/to, keeps ids', () => {
    const crumb = scrubBreadcrumb({
      category: 'navigation',
      data: {
        from: `/book?address=${encodeURIComponent('7 Fixture Way, Testville WA')}`,
        to: `/book/services?${wizardQuery()}`,
      },
    })
    expectNoPii(crumb)
    expectStructureKept(crumb.data?.to)
  })

  it('redacts query values in fetch breadcrumb urls (RSC prefetches)', () => {
    const crumb = scrubBreadcrumb({
      category: 'fetch',
      data: {
        method: 'GET',
        status_code: 200,
        url: `https://kwn.verco.au/book/confirm?${wizardQuery()}&_rsc=abc123`,
      },
    })
    expectNoPii(crumb)
    expectStructureKept(crumb.data?.url)
  })

  it('keeps the encoded items list readable', () => {
    const crumb = scrubBreadcrumb({
      category: 'navigation',
      data: { to: `/book/date?${wizardQuery()}` },
    })
    expect(String(crumb.data?.to)).toContain(
      `items=${encodeURIComponent(`${SERVICE_ID}:2`)}`,
    )
  })
})

describe('scrubEvent — request', () => {
  it('redacts the query in request.url', () => {
    const event = scrubEvent(
      {
        type: undefined,
        request: { url: `https://kwn.verco.au/book/details?${wizardQuery()}` },
      } as ErrorEvent,
      {},
    )
    expectNoPii(event)
    expectStructureKept(event.request?.url)
  })

  it('redacts query_string in string, object and pair-list forms', () => {
    const asString = scrubEvent(
      { type: undefined, request: { query_string: wizardQuery() } } as ErrorEvent,
      {},
    )
    expectNoPii(asString)
    expectStructureKept(asString.request?.query_string)

    const asObject = scrubEvent(
      {
        type: undefined,
        request: {
          query_string: { address: '7 Fixture Way', property_id: PROPERTY_ID },
        },
      } as ErrorEvent,
      {},
    )
    expectNoPii(asObject)
    expect(asObject.request?.query_string).toEqual({
      address: '[redacted]',
      property_id: PROPERTY_ID,
    })

    const asPairs = scrubEvent(
      {
        type: undefined,
        request: {
          query_string: [
            ['notes', 'Gate code 4321'],
            ['property_id', PROPERTY_ID],
          ],
        },
      } as ErrorEvent,
      {},
    )
    expectNoPii(asPairs)
    expect(asPairs.request?.query_string).toEqual([
      ['notes', '[redacted]'],
      ['property_id', PROPERTY_ID],
    ])
  })
})

describe('scrubTransaction — spans', () => {
  it('redacts URLs in request, span descriptions and span attributes', () => {
    const query = wizardQuery()
    const event = scrubTransaction(
      {
        type: 'transaction',
        transaction: '/book/services',
        request: { url: `https://kwn.verco.au/book/services?${query}` },
        contexts: {
          trace: {
            trace_id: 't',
            span_id: 's',
            data: { 'url.full': `https://kwn.verco.au/book/services?${query}` },
          },
        },
        spans: [
          {
            span_id: 'a',
            trace_id: 't',
            start_timestamp: 0,
            description: `GET https://kwn.verco.au/book/services?${query}`,
            data: {
              url: `https://kwn.verco.au/book/services?${query}`,
              'http.url': `https://kwn.verco.au/book/services?${query}`,
              'http.query': `?${query}`,
              'server.address': 'kwn.verco.au',
            },
          },
          {
            span_id: 'b',
            trace_id: 't',
            start_timestamp: 0,
            data: { 'url.query': query, 'http.target': `/book/services?${query}` },
          },
        ],
      } as TransactionEvent,
      {},
    )
    expectNoPii(event)
    expectStructureKept(event.spans?.[0]?.data?.['http.query'])
    expectStructureKept(event.spans?.[1]?.data?.['url.query'])
    // The host is not PII and keeps traces readable.
    expect(event.spans?.[0]?.data?.['server.address']).toBe('kwn.verco.au')
  })
})

describe('redaction no longer mangles ids and dates', () => {
  it('keeps UUIDs and ISO dates intact, still redacts real phone numbers', () => {
    const event = scrubEvent(
      {
        type: undefined,
        message: `booking ${PROPERTY_ID} on 2030-01-02T03:04:05.000Z — call +61 400 000 000`,
      } as ErrorEvent,
      {},
    )
    expect(event.message).toBe(
      `booking ${PROPERTY_ID} on 2030-01-02T03:04:05.000Z — call [phone]`,
    )
  })

  it('still redacts emails and long digit runs in a query', () => {
    const crumb = scrubBreadcrumb({
      category: 'navigation',
      data: { to: '/admin/caller-lookup?phone=0400000000&ref=12' },
    })
    expect(crumb.data?.to).toBe('/admin/caller-lookup?phone=[redacted]&ref=12')
  })
})

describe('date guard does not shelter phone numbers', () => {
  it.each(['0412-34-5678', '1300-12-3456', '0894-11-1234', '0412-34-56789', '0412-12-12-34'])(
    'redacts %s',
    (phone) => {
      const event = scrubEvent(
        { type: undefined, message: `call ${phone} today` } as ErrorEvent,
        {},
      )
      expect(event.message).toBe('call [phone] today')
    },
  )

  it('keeps real dates and timestamps', () => {
    const event = scrubEvent(
      {
        type: undefined,
        message: 'due 2030-12-31, sent 2030-01-02T03:04:05.000Z',
      } as ErrorEvent,
      {},
    )
    expect(event.message).toBe('due 2030-12-31, sent 2030-01-02T03:04:05.000Z')
  })
})

// Sentry builds ui.* breadcrumb messages with htmlTreeAsString, which copies
// the aria-label / title / alt attribute values of the clicked element (e.g. a
// table cell with `title={address}`). Those are free text — redact them; keep
// code-defined `type` / `name`.
describe('scrubBreadcrumb — ui attribute text', () => {
  it('redacts title / aria-label / alt values, keeps type and name', () => {
    const crumb = scrubBreadcrumb({
      category: 'ui.click',
      message:
        'tr.border-b > td.px-4.py-2[title="7 Fixture Way, Testville WA 6000"] > button[aria-label="Call Pat Fixture"][type="button"][name="call"] > img[alt="Pat"]',
    })
    expectNoPii(crumb)
    expect(crumb.message).toBe(
      'tr.border-b > td.px-4.py-2[title="[redacted]"] > button[aria-label="[redacted]"][type="button"][name="call"] > img[alt="[redacted]"]',
    )
  })

  it('redacts an attribute value left unterminated by a truncated message', () => {
    const crumb = scrubBreadcrumb({
      category: 'ui.input',
      message: 'div.flex > td.max-w-[320px].truncate[title="7 Fixture Wa',
    })
    expectNoPii(crumb)
    expect(crumb.message).toBe('div.flex > td.max-w-[320px].truncate[title="[redacted]"]')
  })
})
