import { describe, it, expect } from 'vitest'
import {
  BOOKING_STATUSES,
  TICKET_STATUSES,
  TICKET_STAGE,
  SUPPORT_PIPELINE_ID,
  bookingStatusToOrderStatus,
  ticketStatusToPipelineStage,
} from '@/lib/hubspot/status-maps'

describe('bookingStatusToOrderStatus', () => {
  it('maps all 10 booking_status values to a non-empty string', () => {
    expect(BOOKING_STATUSES).toHaveLength(10)
    for (const s of BOOKING_STATUSES) {
      expect(bookingStatusToOrderStatus(s)).toBe(s)
    }
  })

  it('passes an unknown status through unchanged (never drops information)', () => {
    expect(bookingStatusToOrderStatus('Some Future Status')).toBe('Some Future Status')
  })

  it('falls back to "Unknown" for an empty status', () => {
    expect(bookingStatusToOrderStatus('')).toBe('Unknown')
  })
})

describe('ticketStatusToPipelineStage', () => {
  it('maps the 5 ticket_status values to the live Support Pipeline stage ids', () => {
    expect(TICKET_STATUSES).toHaveLength(5)
    expect(ticketStatusToPipelineStage('open')).toBe(TICKET_STAGE.NEW)
    expect(ticketStatusToPipelineStage('waiting_on_customer')).toBe(TICKET_STAGE.WAITING_ON_CONTACT)
    expect(ticketStatusToPipelineStage('in_progress')).toBe(TICKET_STAGE.WAITING_ON_US)
    expect(ticketStatusToPipelineStage('resolved')).toBe(TICKET_STAGE.CLOSED)
    expect(ticketStatusToPipelineStage('closed')).toBe(TICKET_STAGE.CLOSED)
  })

  it('defaults an unknown status to New (1)', () => {
    expect(ticketStatusToPipelineStage('nonsense')).toBe(TICKET_STAGE.NEW)
    expect(ticketStatusToPipelineStage('')).toBe(TICKET_STAGE.NEW)
  })

  it('uses the confirmed pipeline + stage ids', () => {
    expect(SUPPORT_PIPELINE_ID).toBe('0')
    expect(TICKET_STAGE).toEqual({ NEW: '1', WAITING_ON_CONTACT: '2', WAITING_ON_US: '3', CLOSED: '4' })
  })
})
