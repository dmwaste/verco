import { describe, it, expect } from 'vitest'
import {
  decideExpiryAction,
  type ExpiryPaymentRow,
  type SessionPaidStatus,
} from '@/lib/payments/expiry-decision'

const statuses = (entries: Array<[string, SessionPaidStatus]>) => new Map(entries)

describe('decideExpiryAction', () => {
  it('cancels when there are no payment rows (legacy / no-Stripe path)', () => {
    expect(decideExpiryAction([], statuses([]))).toEqual({ action: 'cancel' })
  })

  it('cancels when rows exist but none carry a session id', () => {
    const rows: ExpiryPaymentRow[] = [{ stripe_session_id: null, status: 'pending' }]
    expect(decideExpiryAction(rows, statuses([]))).toEqual({ action: 'cancel' })
  })

  it('reconciles immediately when a DB row is already marked paid (stuck booking)', () => {
    const rows: ExpiryPaymentRow[] = [
      { stripe_session_id: 'cs_paid', status: 'paid' },
      { stripe_session_id: 'cs_new', status: 'pending' },
    ]
    // No Stripe lookups needed — the DB signal is sufficient.
    expect(decideExpiryAction(rows, statuses([]))).toEqual({
      action: 'reconcile',
      sessionId: 'cs_paid',
    })
  })

  it('reconciles when ANY session is paid — including a shelved-expired row (double-charge vector)', () => {
    const rows: ExpiryPaymentRow[] = [
      { stripe_session_id: 'cs_old', status: 'expired' }, // create-checkout shelved it
      { stripe_session_id: 'cs_new', status: 'pending' },
    ]
    expect(
      decideExpiryAction(
        rows,
        statuses([
          ['cs_old', 'paid'],
          ['cs_new', 'unpaid'],
        ])
      )
    ).toEqual({ action: 'reconcile', sessionId: 'cs_old' })
  })

  it('skips (never cancels) when any session could not be verified', () => {
    const rows: ExpiryPaymentRow[] = [
      { stripe_session_id: 'cs_a', status: 'pending' },
      { stripe_session_id: 'cs_b', status: 'expired' },
    ]
    expect(
      decideExpiryAction(
        rows,
        statuses([
          ['cs_a', 'unpaid'],
          ['cs_b', 'error'],
        ])
      )
    ).toEqual({ action: 'skip' })
  })

  it('skips when a session status is missing from the map entirely', () => {
    const rows: ExpiryPaymentRow[] = [{ stripe_session_id: 'cs_a', status: 'pending' }]
    expect(decideExpiryAction(rows, statuses([]))).toEqual({ action: 'skip' })
  })

  it('cancels when every session is verified unpaid', () => {
    const rows: ExpiryPaymentRow[] = [
      { stripe_session_id: 'cs_a', status: 'expired' },
      { stripe_session_id: 'cs_b', status: 'pending' },
    ]
    expect(
      decideExpiryAction(
        rows,
        statuses([
          ['cs_a', 'unpaid'],
          ['cs_b', 'unpaid'],
        ])
      )
    ).toEqual({ action: 'cancel' })
  })

  it('paid wins over an error on a sibling session', () => {
    const rows: ExpiryPaymentRow[] = [
      { stripe_session_id: 'cs_err', status: 'pending' },
      { stripe_session_id: 'cs_paid', status: 'expired' },
    ]
    expect(
      decideExpiryAction(
        rows,
        statuses([
          ['cs_err', 'error'],
          ['cs_paid', 'paid'],
        ])
      )
    ).toEqual({ action: 'reconcile', sessionId: 'cs_paid' })
  })
})
