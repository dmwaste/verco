import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the "Open Service Tickets" dashboard card against the contacts multi-FK
 * embed gotcha (CLAUDE.md §21). The card's query used `contact!inner(full_name)`;
 * on `contacts` (many inbound FKs) that inner embed silently resolves empty for
 * authed users even when the row is readable, and the `!inner` then drops the
 * whole ticket. Result: an open ticket showed "No open tickets" on the card while
 * the sidebar badge (which does no embed) still counted it.
 *
 * The safe form is the explicit-FK left embed `contact:contact_id(...)`, matching
 * the tickets list page. A revert to the inner embed fails this test.
 */

// Strip comments so the assertions check real code, not the explanatory prose
// above the query (which names the anti-pattern it is avoiding).
const dashboardCode = readFileSync(
  join(__dirname, '../app/(admin)/admin/page.tsx'),
  'utf8'
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

describe('dashboard Open Service Tickets query', () => {
  it('embeds the ticket contact via the explicit FK column, not an inner embed', () => {
    expect(dashboardCode).toContain('contact:contact_id(full_name)')
  })

  it('never uses an inner embed on contact (the empty-inner-drops-row gotcha)', () => {
    expect(dashboardCode).not.toContain('contact!inner')
  })
})
