import { describe, it, expect } from 'vitest'
import { buildQuantityEditItems } from '@/lib/booking/quantity-edit-payload'

// #387.1 view-to-write guard — client side. The inline quantity editor must send
// the create-booking EF BOTH:
//   • `items`         — the admin's TARGET quantities (the editor draft), and
//   • `expectedItems` — the ORIGINAL quantities the page RENDERED when the editor
//                       opened (the concurrency-guard baseline).
//
// Getting these two confused is catastrophic: if the RENDERED baseline were built
// from the draft instead of the original, the RPC guard would compare
// current-under-lock against the target and 409 EVERY legitimate reduction (the
// admin lowered the qty, so current != target with no concurrent edit at all).
// This pins the distinction, which E2E cannot (the edit runs through a server
// action → server-side EF fetch that page.route() can't intercept).

describe('buildQuantityEditItems', () => {
  const A = '5e0c9b8a-7d6f-4c3b-a291-8f7e6d5c4b3a'
  const B = '9a1f6f2e-1c6b-4a1e-9f7d-2b8c3d4e5f60'
  const lines = [
    { service_id: A, qty: 3 },
    { service_id: B, qty: 1 },
  ]

  it('expectedItems is the RENDERED baseline (original quantities), never the draft', () => {
    // Admin reduced A 3→1 in the editor; B untouched.
    const editQty = new Map([[A, 1]])
    const { expectedItems } = buildQuantityEditItems(lines, editQty)
    expect(expectedItems).toEqual([
      { service_id: A, no_services: 3 },
      { service_id: B, no_services: 1 },
    ])
  })

  it('items is the TARGET (draft where edited, original where untouched)', () => {
    const editQty = new Map([[A, 1]])
    const { items } = buildQuantityEditItems(lines, editQty)
    expect(items).toEqual([
      { service_id: A, no_services: 1 }, // edited
      { service_id: B, no_services: 1 }, // untouched → falls back to original
    ])
  })

  it('with no draft edits, items and expectedItems are identical to the original', () => {
    const { items, expectedItems } = buildQuantityEditItems(lines, new Map())
    expect(items).toEqual(expectedItems)
    expect(expectedItems).toEqual([
      { service_id: A, no_services: 3 },
      { service_id: B, no_services: 1 },
    ])
  })
})
