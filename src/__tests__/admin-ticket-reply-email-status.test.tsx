import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Ticket reply email outcome on the admin ticket page (#671 follow-up).
 *
 * The resident email for a public staff reply used to be a bare `void` call:
 * if it didn't go out (gateway failure, SendGrid error), the staff member who
 * just replied never knew, and the resident never heard back. The page now
 * shows when the email didn't send and offers Resend (safe to repeat — the EF
 * claims each reply's send), or says the resident has no email on file.
 */

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

const h = vi.hoisted(() => ({
  outcomes: [] as Array<{ ok: true } | { ok: false; reason: 'not_sent' | 'no_email' }>,
  calls: [] as string[],
}))

vi.mock('@/lib/notifications/invoke-ticket-response', () => ({
  invokeNotifyTicketResponse: async (_supabase: unknown, responseId: string) => {
    h.calls.push(responseId)
    return h.outcomes.shift() ?? { ok: true }
  },
}))

// Just enough of the browser client for the reply insert + profile read.
vi.mock('@/lib/supabase/client', () => {
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['insert', 'select', 'update', 'eq']) c[m] = () => c
    c.single = async () => result
    c.then = (resolve: (v: unknown) => void) => resolve({ error: null })
    return c
  }
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: 'staff-1' } } }) },
      from: (table: string) =>
        table === 'ticket_response'
          ? chain({ data: { id: 'resp-1', created_at: '2026-10-20T03:00:00.000Z' }, error: null })
          : chain({ data: { display_name: 'Staff Member' }, error: null }),
    }),
  }
})

import { AdminTicketDetailClient } from '@/app/(admin)/admin/service-tickets/[id]/admin-ticket-detail-client'

const ticket: ComponentProps<typeof AdminTicketDetailClient>['ticket'] = {
  id: 'ticket-uuid',
  displayId: 'TKT-1001',
  subject: 'Bin not collected',
  message: 'My bin was skipped.',
  status: 'waiting_on_customer',
  priority: 'normal',
  category: 'service',
  channel: 'portal',
  assignedTo: null,
  createdAt: '2026-07-03T01:04:00.000Z',
  updatedAt: '2026-07-03T01:04:00.000Z',
  resolvedAt: null,
  closedAt: null,
}

function renderPage() {
  render(
    <AdminTicketDetailClient
      ticket={ticket}
      contact={null}
      responses={[]}
      staffUsers={[]}
      linkedBooking={null}
      auditLogs={[]}
    />,
  )
}

async function sendReply(text = 'We will collect it tomorrow.') {
  fireEvent.change(screen.getByPlaceholderText(/Write a reply to the resident/), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send Reply' }))
  await waitFor(() => expect(h.calls).toContain('resp-1'))
}

beforeEach(() => {
  h.outcomes = []
  h.calls = []
})

describe('admin ticket page — resident reply email outcome', () => {
  it('says nothing when the email went out', async () => {
    h.outcomes = [{ ok: true }]
    renderPage()
    await sendReply()
    expect(screen.queryByText(/didn’t send/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resend email' })).toBeNull()
  })

  it('shows when the email didn’t send, and Resend clears it once it goes out', async () => {
    h.outcomes = [{ ok: false, reason: 'not_sent' }, { ok: true }]
    renderPage()
    await sendReply()

    expect(await screen.findByText(/the email to the resident didn’t send/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resend email' }))

    await waitFor(() => expect(h.calls).toEqual(['resp-1', 'resp-1']))
    await waitFor(() => expect(screen.queryByText(/didn’t send/)).toBeNull())
  })

  it('says the resident has no email on file, with nothing to resend', async () => {
    h.outcomes = [{ ok: false, reason: 'no_email' }]
    renderPage()
    await sendReply()

    expect(await screen.findByText(/no email address on file/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resend email' })).toBeNull()
  })
})
