import { describe, expect, it } from 'vitest'
import {
  METRIC_AUDIENCE,
  isContractorReportViewer,
  metricVisible,
} from '@/lib/reports/audience'

describe('reports audience gating (VER-288 / decision 8A)', () => {
  const councilRoles = ['client-admin', 'client-staff'] as const
  const contractorRoles = ['contractor-admin', 'contractor-staff'] as const

  it('contractor roles see every declared metric', () => {
    for (const role of contractorRoles) {
      for (const key of Object.keys(METRIC_AUDIENCE)) {
        expect(metricVisible(key, role), `${role} → ${key}`).toBe(true)
      }
    }
  })

  it('council roles see the 8A council-visible set', () => {
    const councilVisible = [
      'service-delivery',
      'on-time-collection',
      'rectification',
      'ticket-first-response',
      'ticket-resolution',
      'customer-satisfaction',
      'service-breakdown',
      'collections-trend',
      'open-notices',
      'notice-types',
      'open-tickets',
    ]
    for (const role of councilRoles) {
      for (const key of councilVisible) {
        expect(metricVisible(key, role), `${role} → ${key}`).toBe(true)
      }
    }
  })

  it('council roles do NOT see D&M ops-health or monetary metrics', () => {
    const contractorOnly = [
      'property-penetration',
      'self-service-rate',
      'notification-delivery',
    ]
    for (const role of councilRoles) {
      for (const key of contractorOnly) {
        expect(metricVisible(key, role), `${role} → ${key}`).toBe(false)
      }
    }
  })

  it('unknown metric keys default to contractor-only (new metrics are internal)', () => {
    expect(metricVisible('some-future-metric', 'contractor-admin')).toBe(true)
    expect(metricVisible('some-future-metric', 'client-admin')).toBe(false)
    expect(metricVisible('some-future-metric', 'client-staff')).toBe(false)
  })

  it('missing/unknown roles are never treated as contractor', () => {
    for (const role of [null, undefined, '', 'resident', 'strata', 'field', 'ranger']) {
      expect(isContractorReportViewer(role)).toBe(false)
      expect(metricVisible('property-penetration', role)).toBe(false)
      // Role-less callers still only get the council-visible set — the page
      // route guard is the auth boundary; this is defence-in-depth.
      expect(metricVisible('service-delivery', role)).toBe(true)
    }
  })
})
