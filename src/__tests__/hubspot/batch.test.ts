import { describe, it, expect } from 'vitest'
import { buildBatchUpsertBody, maxCursor } from '@/lib/hubspot/batch'
import type { HubspotUpsertRecord } from '@/lib/hubspot/types'

const rec = (idProperty: string, id: string): HubspotUpsertRecord => ({
  idProperty,
  id,
  properties: { [idProperty]: id },
})

describe('buildBatchUpsertBody', () => {
  it('shapes records into HubSpot inputs preserving idProperty/id/properties', () => {
    const body = buildBatchUpsertBody([rec('email', 'a@x.com'), rec('email', 'b@x.com')])
    expect(body).toEqual({
      inputs: [
        { idProperty: 'email', id: 'a@x.com', properties: { email: 'a@x.com' } },
        { idProperty: 'email', id: 'b@x.com', properties: { email: 'b@x.com' } },
      ],
    })
  })

  it('returns empty inputs for an empty batch', () => {
    expect(buildBatchUpsertBody([])).toEqual({ inputs: [] })
  })

  it('throws if a batch mixes idProperties (HubSpot rejects this; fail loud)', () => {
    expect(() => buildBatchUpsertBody([rec('email', 'a'), rec('hs_external_order_id', 'b')])).toThrow(
      /share one idProperty/,
    )
  })
})

describe('maxCursor', () => {
  it('returns null for an empty batch (cursor unchanged)', () => {
    expect(maxCursor([])).toBeNull()
  })

  it('returns the max (updated_at, id) row', () => {
    const rows = [
      { updated_at: '2026-05-01T00:00:00.000Z', id: 'b' },
      { updated_at: '2026-05-02T00:00:00.000Z', id: 'a' },
      { updated_at: '2026-05-01T00:00:00.000Z', id: 'c' },
    ]
    expect(maxCursor(rows)).toEqual({ updated_at: '2026-05-02T00:00:00.000Z', id: 'a' })
  })

  it('finds the true max even from an unordered slice (defensive)', () => {
    const rows = [
      { updated_at: '2026-05-03T00:00:00.000Z', id: 'z' },
      { updated_at: '2026-05-01T00:00:00.000Z', id: 'a' },
    ]
    expect(maxCursor(rows)).toEqual({ updated_at: '2026-05-03T00:00:00.000Z', id: 'z' })
  })
})
