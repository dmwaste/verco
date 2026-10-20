/**
 * Importers never store a phone the booking forms would reject (#668).
 *
 * 72 contacts came in from Airtable with an AU number a digit short or long,
 * stored raw, so those residents silently got no SMS. An import now stores no
 * number for them and prints a report line so staff can follow up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakeContactsDb } from '../../src/__tests__/helpers/fake-contacts-db'
import { resolveResidentContact, upsertContact } from '../lib/contact-upsert'

const contact = (mobileE164: string) => ({ email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee', mobileE164 })

afterEach(() => vi.restoreAllMocks())

describe.each([
  ['resolveResidentContact', (db: SupabaseClient, mobile: string) => resolveResidentContact(db, contact(mobile))],
  ['upsertContact', (db: SupabaseClient, mobile: string) => upsertContact(db, contact(mobile), false)],
] as const)('%s', (_name, attach) => {
  it('stores no number, flags it and reports a masked shape for a wrong-length AU number', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeContactsDb({ contacts: [] })

    const r = await attach(db.client as unknown as SupabaseClient, '041312345')

    expect(r).toMatchObject({ contactId: 'new-1', created: true, phoneRejected: true })
    expect(db.inserts).toEqual([expect.objectContaining({ mobile_e164: null })])
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('new-1')
    expect(line).toContain('0413ddddd')
    expect(line).not.toContain('041312345')
  })

  it('stores a valid number as given and reports nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeContactsDb({ contacts: [] })

    const r = await attach(db.client as unknown as SupabaseClient, '+61412345678')

    expect(r.phoneRejected).toBe(false)
    expect(db.inserts).toEqual([expect.objectContaining({ mobile_e164: '+61412345678' })])
    expect(warn).not.toHaveBeenCalled()
  })
})

it('upsertContact reports a rejected number on a dry run too, without writing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const db = fakeContactsDb({ contacts: [] })

  const r = await upsertContact(db.client as unknown as SupabaseClient, contact('9385 1234'), true)

  expect(r).toMatchObject({ contactId: null, created: false, phoneRejected: true })
  expect(db.inserts).toEqual([])
  expect(String(warn.mock.calls[0]?.[0])).toContain('dry run')
})
