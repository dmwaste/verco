import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * upsertStrataContact — staff save of a MUD's strata contact (#668 follow-up).
 *
 * The stricter phone gate ran on every save, so a strata contact already on
 * file with a wrong-length number (one of the 91 left for staff on 18/10/2026)
 * couldn't have a typo in its email fixed without also finding the right phone.
 * Like updateContact, only a number the save changes is checked now.
 */

const h = vi.hoisted(() => ({
  storedMobile: null as string | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}))

vi.mock('@/lib/auth/server', () => ({
  validateStaffRole: () => Promise.resolve({ ok: true, data: 'contractor-admin' }),
}))

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

vi.mock('@/lib/supabase/server', () => {
  const propertyBuilder: Record<string, unknown> = {}
  propertyBuilder.select = () => propertyBuilder
  propertyBuilder.eq = () => propertyBuilder
  propertyBuilder.maybeSingle = () =>
    Promise.resolve({
      data: { strata_contact: h.storedMobile === null ? null : { mobile_e164: h.storedMobile } },
      error: null,
    })
  return {
    createClient: () =>
      Promise.resolve({
        from: () => propertyBuilder,
        rpc: (name: string, args: Record<string, unknown>) => {
          h.rpcCalls.push({ name, args })
          return Promise.resolve({ data: { contact_id: 'c0000000-0000-4000-8000-000000000001' }, error: null })
        },
      }),
  }
})

import { upsertStrataContact } from '@/app/(admin)/admin/properties/actions'
import { PHONE_INVALID_MESSAGE } from '@/lib/phone'

const PROPERTY_ID = 'a0000000-0000-4000-8000-000000000001'
const save = (mobile_e164: string, email = 'manager@example.com') => ({
  property_id: PROPERTY_ID,
  first_name: 'Sam',
  last_name: 'Fixture',
  mobile_e164,
  email,
})

beforeEach(() => {
  h.storedMobile = '+61411111111'
  h.rpcCalls = []
})

describe('upsertStrataContact phone gate', () => {
  it('rejects a new wrong-length number without writing', async () => {
    const result = await upsertStrataContact(save('0413 12345'))
    expect(result).toEqual({ ok: false, error: PHONE_INVALID_MESSAGE })
    expect(h.rpcCalls).toEqual([])
  })

  it('stores a new valid mobile as E.164', async () => {
    const result = await upsertStrataContact(save('0412 345 678'))
    expect(result.ok).toBe(true)
    expect(h.rpcCalls).toEqual([
      expect.objectContaining({
        name: 'upsert_strata_contact_and_link',
        args: expect.objectContaining({ p_mobile_e164: '+61412345678' }),
      }),
    ])
  })

  it('still saves an email fix when the wrong-length number on file is unchanged', async () => {
    h.storedMobile = '+6141234567'
    const result = await upsertStrataContact(save('+6141234567', 'manager.fixed@example.com'))
    expect(result.ok).toBe(true)
    expect(h.rpcCalls).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ p_email: 'manager.fixed@example.com', p_mobile_e164: '+6141234567' }),
      }),
    ])
  })

  it('checks the number when there is no strata contact on file yet', async () => {
    h.storedMobile = null
    const result = await upsertStrataContact(save('0404 1234567'))
    expect(result).toEqual({ ok: false, error: PHONE_INVALID_MESSAGE })
  })
})
