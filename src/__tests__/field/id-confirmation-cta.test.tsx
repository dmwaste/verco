import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Confirmation } from '@/app/(field)/field/illegal-dumping/new/confirmation'

/**
 * Regression guard: the ID-collection confirmation is only ever reached by a
 * ranger — the ID form's page hard-gates `role === 'ranger'` and redirects
 * everyone else (illegal-dumping/new/page.tsx). Rangers have NO Run Sheet tab
 * (their tabs are Lookup / New ID / My IDs), so the primary CTA must send them
 * to My IDs, not the crew's legacy /field/run-sheet (which would redirect).
 */
describe('ID confirmation primary CTA', () => {
  function renderConfirmation() {
    render(
      <Confirmation
        bookingRef="VV-10636"
        geoAddress="12 Test St, Safety Bay"
        wasteTypes={['General / Mixed']}
        volume="Small (car boot)"
        collectionDate="2026-07-10"
      />,
    )
  }

  it('routes the ranger to /field/my-ids, never the crew run sheet', () => {
    renderConfirmation()

    const cta = screen.getByRole('link', { name: /View My IDs/i })
    expect(cta).toHaveAttribute('href', '/field/my-ids')
  })

  it('has no link to /field/run-sheet (rangers cannot open it)', () => {
    renderConfirmation()

    const runSheetLink = screen
      .queryAllByRole('link')
      .find((el) => el.getAttribute('href') === '/field/run-sheet')
    expect(runSheetLink).toBeUndefined()
  })
})
