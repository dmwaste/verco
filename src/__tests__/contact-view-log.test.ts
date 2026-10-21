import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Contact view log (VER-322, PRIS gap 7, ADR 0040): every contact a staff
 * screen shows is recorded once per view, and the database stamps who and when.
 * A failed write never blocks the page — a resident is on the phone — it goes
 * to Sentry instead.
 */

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }))
vi.mock('@sentry/nextjs', () => ({ captureMessage }))

import { logContactViews } from '@/lib/contacts/view-log'

function makeFake(error: { message: string; code?: string } | null = null) {
  const insert = vi.fn(async () => ({ error }))
  const from = vi.fn(() => ({ insert }))
  return { client: { from } as unknown as Parameters<typeof logContactViews>[0], from, insert }
}

describe('logContactViews', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes one row per contact shown, leaving who and when to the database', async () => {
    const { client, from, insert } = makeFake()

    await logContactViews(client, ['c-a', 'c-b', 'c-a'], 'caller_lookup')

    expect(from).toHaveBeenCalledWith('contact_view_log')
    expect(insert).toHaveBeenCalledWith([
      { contact_id: 'c-a', surface: 'caller_lookup' },
      { contact_id: 'c-b', surface: 'caller_lookup' },
    ])
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('writes nothing when no contact was shown', async () => {
    const { client, from } = makeFake()

    await logContactViews(client, [], 'caller_lookup')

    expect(from).not.toHaveBeenCalled()
  })

  it('reports a failed write to Sentry without blocking the page', async () => {
    const { client } = makeFake({ message: 'permission denied for table contact_view_log', code: '42501' })

    await expect(logContactViews(client, ['c-a'], 'caller_lookup')).resolves.toBeUndefined()

    expect(captureMessage).toHaveBeenCalledWith('Contact view log write failed', {
      level: 'warning',
      extra: { surface: 'caller_lookup', contacts: 1, code: '42501', error: 'permission denied for table contact_view_log' },
    })
  })
})
