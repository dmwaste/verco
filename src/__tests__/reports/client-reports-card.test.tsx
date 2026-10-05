import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const CLIENT_ID = '123e4567-e89b-42d3-a456-426614174000'

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn(() => ({})) }))
vi.mock('@/lib/admin/accessible-clients', () => ({
  fetchAccessibleClientOptions: vi.fn(async () => [{ id: CLIENT_ID, name: 'Verge Valet' }]),
}))

import { ClientReportsCard, lastCompleteMonth } from '@/app/(admin)/admin/reports/client-reports-card'

describe('ClientReportsCard', () => {
  it('offers the same statement as a PDF and an Excel download for the chosen client + month', async () => {
    render(<ClientReportsCard />)
    const month = lastCompleteMonth(new Date())

    const pdf = await screen.findByRole('link', { name: 'Download PDF' })
    const xlsx = screen.getByRole('link', { name: 'Download Excel' })

    await vi.waitFor(() =>
      expect(pdf.getAttribute('href')).toBe(
        `/admin/reports/client-report/pdf?client=${CLIENT_ID}&month=${month}`
      )
    )
    expect(xlsx.getAttribute('href')).toBe(
      `/admin/reports/client-report/xlsx?client=${CLIENT_ID}&month=${month}`
    )
    expect(xlsx.hasAttribute('download')).toBe(true)
    expect(xlsx.getAttribute('aria-disabled')).toBe('false')
  })
})
