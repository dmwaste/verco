import { describe, it, expect } from 'vitest'
import { assertRowsAffected } from '@/lib/db/assert-rows-affected'

// Regression guard for the F5 (VER-247) silent-RLS-no-op class: a PostgREST
// mutation blocked by RLS returns no error and an empty array, and a caller
// that only checks `error` reports a false success.
describe('assertRowsAffected', () => {
  it('returns ok with the data when rows were affected', () => {
    expect(assertRowsAffected([{ id: 'a' }], null, 'nope')).toEqual({
      ok: true,
      data: [{ id: 'a' }],
    })
  })

  it('returns err on empty data — the silent no-op the guard exists to catch', () => {
    expect(assertRowsAffected([], null, 'could not cancel')).toEqual({
      ok: false,
      error: 'could not cancel',
    })
  })

  it('returns err on null data', () => {
    expect(assertRowsAffected(null, null, 'could not cancel').ok).toBe(false)
  })

  it('surfaces a real db error message when present', () => {
    expect(assertRowsAffected(null, { message: 'boom' }, 'fallback')).toEqual({
      ok: false,
      error: 'boom',
    })
  })

  it('prefers the db error over the empty-rows message', () => {
    expect(assertRowsAffected([], { message: 'db said no' }, 'empty')).toEqual({
      ok: false,
      error: 'db said no',
    })
  })
})
