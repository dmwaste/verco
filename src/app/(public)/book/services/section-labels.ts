export interface ServiceSectionLabels {
  /** Heading over the bulk-category services. */
  bulk: string
  /** Heading over the ancillary-category services. */
  anc: string
  /** One line under the ancillary heading, or null for none. */
  ancNote: string | null
  /** Small label under each ancillary service, or null for the category name. */
  ancItemLabel: string | null
}

const VV_EXTRA = 'Verge Valet™ Extra'

/**
 * Select-services headings per tenant. Verge Valet calls its paid ancillary
 * collections Verge Valet™ Extra (WMRC, 26/10/2026): residents read
 * "Ancillary collection" as the way to book a mattress on its own, when it is
 * the paid service for after the annual bulk allocation is used.
 */
export function serviceSectionLabels(clientSlug: string): ServiceSectionLabels {
  if (clientSlug === 'vergevalet') {
    return {
      bulk: 'Collection',
      anc: VV_EXTRA,
      ancNote: "Paid collections, available once you've used your annual bulk waste allocation.",
      ancItemLabel: VV_EXTRA,
    }
  }
  return { bulk: 'Bulk collection', anc: 'Ancillary collection', ancNote: null, ancItemLabel: null }
}
