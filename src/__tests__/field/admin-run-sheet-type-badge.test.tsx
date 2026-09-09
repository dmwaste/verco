import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { RunSheetDetailClient } from '@/app/(admin)/admin/run-sheets/[date]/[driver]/run-sheet-detail-client'

/**
 * The admin run sheet is the ops print view of the same stops the crew
 * works. It must carry the same MUD / ID marker, and the marker must be
 * visible on paper — never print-hidden like the status column.
 */
describe('admin run sheet marks MUD and ID jobs', () => {
  const base: ComponentProps<typeof RunSheetDetailClient>['stops'][number] = {
    id: 'stop-1',
    stream: 'general',
    status: 'Pending',
    address: '12 Strata Way, Mosman Park WA 6012',
    latitude: -32.0,
    longitude: 115.76,
    services_summary: [{ name: 'Bulk Waste', qty: 4 }],
    waste_location: null,
    driver_notes: null,
    stop_sequence: 1,
    scheduled_at: null,
    driver_serial: 'VV-01',
    driver_name: 'Driver B',
    booking: { id: 'b1', ref: 'VV-STOP1', status: 'Scheduled', type: 'Residential', property: null },
    client: null,
  }

  it('a MUD row shows the badge with the unit count, and it is not print-hidden', () => {
    render(
      <RunSheetDetailClient
        date="2026-06-16"
        driverSerial="VV-01"
        stops={[{ ...base, booking: { ...base.booking, type: 'MUD', property: { unit_count: 38 } } }]}
        runMeta={null}
      />,
    )
    const badge = screen.getByText('MUD · 38 units')
    expect(badge).toBeInTheDocument()
    expect(badge.className).not.toMatch(/print:hidden/)
    expect(badge.closest('[class*="print:hidden"]')).toBeNull()
  })

  it('an Illegal Dumping row shows the ID badge', () => {
    render(
      <RunSheetDetailClient
        date="2026-06-16"
        driverSerial="VV-01"
        stops={[
          {
            ...base,
            id: 'stop-2',
            stream: 'illegal_dumping',
            booking: { ...base.booking, ref: 'VV-STOP2', type: 'Illegal Dumping', property: null },
          },
        ]}
        runMeta={null}
      />,
    )
    expect(screen.getByText('ID')).toBeInTheDocument()
  })

  it('a residential row carries no job-type badge', () => {
    render(
      <RunSheetDetailClient date="2026-06-16" driverSerial="VV-01" stops={[base]} runMeta={null} />,
    )
    expect(screen.queryByText(/^MUD/)).not.toBeInTheDocument()
    expect(screen.queryByText('ID')).not.toBeInTheDocument()
  })
})
