import type { BookingForDispatch } from '@/lib/notifications/dispatch'

/**
 * Fixtures for the admin template-preview catalog. NEVER used in a real
 * send — preview pages call the `render*` functions directly with these
 * shapes. Distinct from `src/__tests__/notifications/fixtures.ts` because
 * production code must not import from `__tests__/`.
 *
 * Three tenants:
 *   - Verge Valet (WMRC)   — green brand, custom subdomain
 *   - Verco Kwinana        — navy brand, custom subdomain
 *   - Unbranded mock       — null logo, null colour, default footer
 */

export type PreviewTenant = 'vergevalet' | 'kwn' | 'unbranded'

export const PREVIEW_TENANT_LABELS: Record<PreviewTenant, string> = {
  vergevalet: 'Verge Valet',
  kwn: 'Verco Kwinana',
  unbranded: 'Unbranded',
}

function makeClient(tenant: PreviewTenant): BookingForDispatch['client'] {
  switch (tenant) {
    case 'vergevalet':
      return {
        name: 'Verge Valet',
        slug: 'vergevalet',
        custom_domain: 'vvtest.verco.au',
        logo_light_url: 'https://vergevalet.com.au/logo-light.png',
        primary_colour: '#00E47C',
        email_footer_html:
          '<p style="margin:0;color:#666;font-size:11px">Verge Valet is a service of the Western Metropolitan Regional Council.</p>',
        reply_to_email: 'hello@vergevalet.com.au',
        email_from_name: 'Verge Valet',
        twilio_messaging_service_sid: 'MG44a9c63be9380fcafc23a1f1efe86733',
      }
    case 'kwn':
      return {
        name: 'City of Kwinana',
        slug: 'kwn',
        custom_domain: 'kwntest.verco.au',
        logo_light_url: 'https://www.kwinana.wa.gov.au/logo.png',
        primary_colour: '#293F52',
        email_footer_html:
          '<p style="margin:0;color:#666;font-size:11px">City of Kwinana — verge collection enquiries: customer@kwinana.wa.gov.au</p>',
        reply_to_email: 'customer@kwinana.wa.gov.au',
        email_from_name: 'City of Kwinana — Verge Collection',
        twilio_messaging_service_sid: 'MG3247a987de2cd0b550904b7973305780',
      }
    case 'unbranded':
      return {
        name: 'Bare Council',
        slug: 'mock-tenant',
        custom_domain: null,
        logo_light_url: null,
        primary_colour: null,
        email_footer_html: null,
        reply_to_email: null,
        email_from_name: null,
        twilio_messaging_service_sid: null,
      }
  }
}

/**
 * Realistic mixed-cart booking — two free General + one paid extra General.
 * Picked to exercise the most template branches (services table, free vs
 * paid rows, total-paid line). Uses a deterministic future-ish date so
 * `formatCollectionDate` output is predictable.
 */
export function makePreviewBooking(tenant: PreviewTenant): BookingForDispatch {
  const client = makeClient(tenant)
  return {
    id: 'preview-booking-id',
    ref: tenant === 'kwn' ? 'KWN-PRE001' : tenant === 'vergevalet' ? 'COT-PRE001' : 'MOCK-PRE001',
    type: 'Residential',
    client_id: 'preview-client-id',
    address:
      tenant === 'kwn'
        ? '23 Leda Blvd, Wellard WA 6170'
        : tenant === 'vergevalet'
          ? '11A Loma St, Cottesloe WA 6011'
          : '1 Sample St, Suburb WA 6000',
    collection_date: '2026-04-15',
    items: [
      { service_name: 'General', no_services: 2, is_extra: false, line_charge_cents: 0 },
      { service_name: 'General', no_services: 1, is_extra: true, line_charge_cents: 5500 },
      { service_name: 'Green Waste', no_services: 1, is_extra: false, line_charge_cents: 0 },
    ],
    total_charge_cents: 5500,
    client,
    contact: {
      id: 'preview-contact-id',
      full_name: 'Jane Resident',
      email: 'jane.resident@example.test',
      mobile_e164: '+61412345678',
    },
  }
}
