import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * updateContact — staff edit of a booking's contact (#668).
 *
 * The edit stored any phone it was given, so a number a digit short or long
 * reached the resident's contact and they silently got no SMS. A new number
 * must now pass the same gate as the booking forms. A contact already on file
 * with a bad number (one of the 91 left for staff) can still have its name or
 * email fixed: only a number the edit changes is checked.
 */

const h = vi.hoisted(() => ({
  current: null as { first_name: string; last_name: string; email: string; mobile_e164: string | null } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}))

vi.mock('@/lib/supabase/server', () => {
  const bookingBuilder: Record<string, unknown> = {}
  bookingBuilder.select = () => bookingBuilder
  bookingBuilder.eq = () => bookingBuilder
  bookingBuilder.single = () => Promise.resolve({ data: { contact: h.current }, error: null })
  return {
    createClient: () =>
      Promise.resolve({
        from: () => bookingBuilder,
        rpc: (name: string, args: Record<string, unknown>) => {
          if (name === 'current_user_role') return Promise.resolve({ data: 'client-staff', error: null })
          h.rpcCalls.push({ name, args })
          return Promise.resolve({ data: null, error: null })
        },
      }),
  }
})

import { updateContact } from '@/app/(admin)/admin/bookings/[id]/actions'
import { PHONE_INVALID_MESSAGE } from '@/lib/phone'

const BOOKING_ID = 'b0000000-0000-4000-8000-000000000001'
const edit = (mobile_e164: string | null, first_name = 'Ann') =>
  ({ first_name, last_name: 'Lee', email: 'ann@example.com', mobile_e164 })

beforeEach(() => {
  h.current = { first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com', mobile_e164: '+61411111111' }
  h.rpcCalls = []
})

describe('updateContact phone gate', () => {
  it.each(['0413 12345', '0404 1234567', '9385 1234'])('rejects a new wrong-length number %s without writing', async (mobile) => {
    const result = await updateContact(BOOKING_ID, edit(mobile))
    expect(result).toEqual({ ok: false, error: PHONE_INVALID_MESSAGE })
    expect(h.rpcCalls).toEqual([])
  })

  it('stores a new valid mobile as E.164', async () => {
    const result = await updateContact(BOOKING_ID, edit('0412 345 678'))
    expect(result.ok).toBe(true)
    expect(h.rpcCalls).toEqual([
      expect.objectContaining({ name: 'update_booking_contact', args: expect.objectContaining({ p_mobile_e164: '+61412345678' }) }),
    ])
  })

  it('still saves a name fix on a contact whose number on file is already wrong-length', async () => {
    h.current = { ...h.current!, mobile_e164: '041312345' }
    const result = await updateContact(BOOKING_ID, edit('041312345', 'Anne'))
    expect(result.ok).toBe(true)
    expect(h.rpcCalls).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ p_first_name: 'Anne', p_mobile_e164: '041312345' }) }),
    ])
  })
})
