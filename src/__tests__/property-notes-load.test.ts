import { describe, it, expect, vi } from 'vitest'
import { loadPropertyNotes } from '@/lib/property-notes/load'

/**
 * Property notes for one or more properties (ADR 0031): the property page reads
 * one, the caller lookup reads every property on the caller's bookings
 * (VER-321). RLS scopes the rows; a failed read is null, never an empty list,
 * which would read as "no permission-to-enter form on file".
 */

type Filter = [op: string, col: string, value: unknown]

function makeFake(opts: {
  rows: unknown[] | null
  error?: { message: string } | null
  names?: Array<{ user_id: string; name: string }>
  signed?: Array<{ path: string; signedUrl: string }>
}) {
  const filters: Filter[] = []
  const rpc = vi.fn(async () => ({ data: opts.names ?? [], error: null }))
  const createSignedUrls = vi.fn(async () => ({ data: opts.signed ?? [], error: null }))
  const from = vi.fn(() => {
    const builder = {
      select: () => builder,
      in: (col: string, v: unknown) => (filters.push(['in', col, v]), builder),
      is: (col: string, v: unknown) => (filters.push(['is', col, v]), builder),
      order: () => builder,
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: opts.rows, error: opts.error ?? null }).then(res, rej),
    }
    return builder
  })
  const client = { from, rpc, storage: { from: () => ({ createSignedUrls }) } }
  return { client: client as unknown as Parameters<typeof loadPropertyNotes>[0], filters, from, rpc, createSignedUrls }
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'n-1',
  property_id: 'p-1',
  kind: 'note',
  body: 'Gate code 1234',
  file_path: null,
  file_name: null,
  file_size: null,
  created_at: '2026-10-20T01:00:00Z',
  created_by: 'u-1',
  ...over,
})

describe('loadPropertyNotes', () => {
  it('reads only active notes for the given properties', async () => {
    const { client, filters } = makeFake({ rows: [] })

    expect(await loadPropertyNotes(client, ['p-1', 'p-2'])).toEqual([])
    expect(filters).toContainEqual(['in', 'property_id', ['p-1', 'p-2']])
    expect(filters).toContainEqual(['is', 'removed_at', null])
  })

  it('asks for nothing when there are no properties', async () => {
    const { client, from } = makeFake({ rows: [] })

    expect(await loadPropertyNotes(client, [])).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('returns null when the read fails', async () => {
    const { client } = makeFake({ rows: null, error: { message: 'statement timeout' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await loadPropertyNotes(client, ['p-1'])).toBeNull()
  })

  it('names the author and signs file links, keeping each note’s property', async () => {
    const { client, rpc } = makeFake({
      rows: [
        row(),
        row({ id: 'n-2', property_id: 'p-2', kind: 'access_form', body: null, file_path: 'c/p-2/f.pdf', file_name: 'f.pdf', file_size: 10, created_by: 'u-2' }),
      ],
      names: [{ user_id: 'u-1', name: 'Staff One' }],
      signed: [{ path: 'c/p-2/f.pdf', signedUrl: 'https://example.test/signed' }],
    })

    const notes = await loadPropertyNotes(client, ['p-1', 'p-2'])

    expect(rpc).toHaveBeenCalledWith('resolve_actor_names', { p_user_ids: ['u-1', 'u-2'] })
    expect(notes).toEqual([
      expect.objectContaining({ id: 'n-1', property_id: 'p-1', author_name: 'Staff One', file_url: null }),
      expect.objectContaining({ id: 'n-2', property_id: 'p-2', author_name: null, file_url: 'https://example.test/signed' }),
    ])
  })
})
