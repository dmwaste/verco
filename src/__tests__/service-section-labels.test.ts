import { describe, expect, it } from 'vitest'
import { serviceSectionLabels } from '@/app/(public)/book/services/section-labels'

describe('serviceSectionLabels — select-services headings per tenant', () => {
  it('Verge Valet: the ancillary section is Verge Valet™ Extra, explained as paid and post-allocation', () => {
    // WMRC 26/10/2026: residents read "Ancillary collection" as the way to book
    // a mattress on its own.
    const labels = serviceSectionLabels('vergevalet')
    expect(labels.bulk).toBe('Collection')
    expect(labels.anc).toBe('Verge Valet™ Extra')
    expect(labels.ancItemLabel).toBe('Verge Valet™ Extra')
    expect(labels.ancNote).toBe("Paid collections, available once you've used your annual bulk waste allocation.")
    expect(Object.values(labels).join(' ')).not.toMatch(/ancillary/i)
  })

  it('every other tenant keeps the existing headings (Kwinana swap copy and E2E depend on them)', () => {
    for (const slug of ['kwn', '', 'some-new-council']) {
      expect(serviceSectionLabels(slug)).toEqual({
        bulk: 'Bulk collection',
        anc: 'Ancillary collection',
        ancNote: null,
        ancItemLabel: null,
      })
    }
  })
})
