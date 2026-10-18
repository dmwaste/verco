// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { render, screen } from '@testing-library/react'
import { BookingTicketsCard } from '@/components/admin/booking-tickets-card'

/**
 * The ticket detail route (/admin/service-tickets/[id]) resolves by
 * `display_id` and redirects to the list on a miss. A link built from the row
 * UUID therefore always bounced staff to the list: the booking page's Service
 * Tickets card and the property page's tickets table both did.
 */

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

// `/admin/service-tickets/${t.id}`, `${ticket.id}`, `${id}` …: any row-id link.
const ROW_ID_TICKET_LINK = /\/admin\/service-tickets\/\$\{(?:[\w.]+\.)?id\}/

describe('admin service-ticket links', () => {
  it('the booking page tickets card links each ticket by display id', () => {
    render(
      <BookingTicketsCard
        tickets={[
          { id: 'row-uuid', display_id: 'TKT-1001', subject: 'Missed pickup', status: 'open', category: 'general', created_at: '2026-10-01T02:00:00Z' },
        ]}
      />,
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe('/admin/service-tickets/TKT-1001')
  })

  it('no admin surface builds a ticket link from the row id', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => ROW_ID_TICKET_LINK.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
    expect(offenders).toEqual([])
  })
})
