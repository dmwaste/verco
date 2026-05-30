import { describe, it, expect } from 'vitest'
import {
  sendgridEventToStatus,
  shouldApplyDeliveryStatus,
  isNegativeDeliveryStatus,
  deliveryStatusRank,
  type DeliveryStatus,
} from '@/lib/notifications/sendgrid-events'

describe('sendgridEventToStatus', () => {
  it('maps the six subscribed SendGrid events', () => {
    expect(sendgridEventToStatus('delivered')).toBe('delivered')
    expect(sendgridEventToStatus('open')).toBe('opened')
    expect(sendgridEventToStatus('deferred')).toBe('deferred')
    expect(sendgridEventToStatus('bounce')).toBe('bounced')
    expect(sendgridEventToStatus('dropped')).toBe('dropped')
    expect(sendgridEventToStatus('spamreport')).toBe('spam')
  })

  it('returns null for events we ignore (processed, click, unknown)', () => {
    expect(sendgridEventToStatus('processed')).toBeNull()
    expect(sendgridEventToStatus('click')).toBeNull()
    expect(sendgridEventToStatus('group_unsubscribe')).toBeNull()
    expect(sendgridEventToStatus('')).toBeNull()
  })
})

describe('shouldApplyDeliveryStatus — never downgrade a negative state', () => {
  it('applies anything to a null (unset) current status', () => {
    const all: DeliveryStatus[] = ['delivered', 'opened', 'deferred', 'bounced', 'dropped', 'spam']
    for (const s of all) expect(shouldApplyDeliveryStatus(null, s)).toBe(true)
  })

  it('lets a positive event progress (delivered → opened)', () => {
    expect(shouldApplyDeliveryStatus('delivered', 'opened')).toBe(true)
  })

  it('does NOT downgrade opened → delivered (out-of-order positive events)', () => {
    expect(shouldApplyDeliveryStatus('opened', 'delivered')).toBe(false)
  })

  it('a bounce/spam/drop always wins over a positive state', () => {
    expect(shouldApplyDeliveryStatus('delivered', 'bounced')).toBe(true)
    expect(shouldApplyDeliveryStatus('opened', 'spam')).toBe(true)
    expect(shouldApplyDeliveryStatus('deferred', 'dropped')).toBe(true)
  })

  it('a late "delivered" never masks a prior bounce', () => {
    expect(shouldApplyDeliveryStatus('bounced', 'delivered')).toBe(false)
    expect(shouldApplyDeliveryStatus('spam', 'opened')).toBe(false)
  })

  it('equal-significance negatives may overwrite each other', () => {
    expect(shouldApplyDeliveryStatus('bounced', 'dropped')).toBe(true)
  })
})

describe('rank helpers', () => {
  it('negative states rank highest', () => {
    expect(isNegativeDeliveryStatus('bounced')).toBe(true)
    expect(isNegativeDeliveryStatus('dropped')).toBe(true)
    expect(isNegativeDeliveryStatus('spam')).toBe(true)
    expect(isNegativeDeliveryStatus('deferred')).toBe(false)
    expect(isNegativeDeliveryStatus('delivered')).toBe(false)
    expect(isNegativeDeliveryStatus('opened')).toBe(false)
  })

  it('rank ordering: negative > deferred > opened > delivered', () => {
    expect(deliveryStatusRank('bounced')).toBeGreaterThan(deliveryStatusRank('deferred'))
    expect(deliveryStatusRank('deferred')).toBeGreaterThan(deliveryStatusRank('opened'))
    expect(deliveryStatusRank('opened')).toBeGreaterThan(deliveryStatusRank('delivered'))
  })
})
