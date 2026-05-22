import { describe, it, expect } from 'vitest'
import {
  canTransition,
  getValidTargets,
  canMarkRegistered,
  MUD_ONBOARDING_STATUSES,
  type MudOnboardingStatus,
  type MudRegisteredPrereqs,
} from '@/lib/mud/state-machine'

const ALL: MudOnboardingStatus[] = [...MUD_ONBOARDING_STATUSES]

const fullPrereqs: MudRegisteredPrereqs = {
  is_mud: true,
  unit_count: 12,
  strata_contact_id: '11111111-1111-1111-1111-111111111111',
  auth_form_url: 'https://example.com/auth.pdf',
  waste_location_notes: 'Bins out the front',
  collection_cadence: 'Quarterly',
}

describe('MUD state machine — canTransition', () => {
  it('Contact Made → Registered is allowed', () => {
    expect(canTransition('Contact Made', 'Registered')).toBe(true)
  })

  it('Registered → Inactive is allowed', () => {
    expect(canTransition('Registered', 'Inactive')).toBe(true)
  })

  it('Inactive → Registered is allowed (no re-onboarding)', () => {
    expect(canTransition('Inactive', 'Registered')).toBe(true)
  })

  it('Contact Made → Inactive is disallowed (delete instead)', () => {
    expect(canTransition('Contact Made', 'Inactive')).toBe(false)
  })

  it('Registered → Contact Made is disallowed', () => {
    expect(canTransition('Registered', 'Contact Made')).toBe(false)
  })

  it('Inactive → Contact Made is disallowed', () => {
    expect(canTransition('Inactive', 'Contact Made')).toBe(false)
  })

  it('any state → same state is disallowed', () => {
    for (const s of ALL) {
      expect(canTransition(s, s)).toBe(false)
    }
  })

  it('exhaustive cross-product matches the spec', () => {
    const expected: Array<[MudOnboardingStatus, MudOnboardingStatus, boolean]> = [
      ['Contact Made', 'Contact Made', false],
      ['Contact Made', 'Registered', true],
      ['Contact Made', 'Inactive', false],
      ['Registered', 'Contact Made', false],
      ['Registered', 'Registered', false],
      ['Registered', 'Inactive', true],
      ['Inactive', 'Contact Made', false],
      ['Inactive', 'Registered', true],
      ['Inactive', 'Inactive', false],
    ]
    for (const [from, to, ok] of expected) {
      expect(canTransition(from, to)).toBe(ok)
    }
  })
})

describe('MUD state machine — getValidTargets', () => {
  it('Contact Made has Registered as the only target', () => {
    expect(getValidTargets('Contact Made')).toEqual(['Registered'])
  })

  it('Registered has Inactive as the only target', () => {
    expect(getValidTargets('Registered')).toEqual(['Inactive'])
  })

  it('Inactive has Registered as the only target', () => {
    expect(getValidTargets('Inactive')).toEqual(['Registered'])
  })
})

describe('MUD state machine — canMarkRegistered', () => {
  it('all prereqs met → ok', () => {
    const result = canMarkRegistered(fullPrereqs)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('not flagged as MUD → error', () => {
    const result = canMarkRegistered({ ...fullPrereqs, is_mud: false })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Property is not flagged as a MUD.')
  })

  it('unit_count = 0 → error (not yet recorded)', () => {
    const result = canMarkRegistered({ ...fullPrereqs, unit_count: 0 })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('Unit count must be recorded'))).toBe(true)
  })

  it('unit_count = 1 → ok (any positive count is valid)', () => {
    const result = canMarkRegistered({ ...fullPrereqs, unit_count: 1 })
    expect(result.ok).toBe(true)
  })

  it('missing strata_contact_id → error', () => {
    const result = canMarkRegistered({ ...fullPrereqs, strata_contact_id: null })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Strata contact is required.')
  })

  it('missing auth_form_url → error', () => {
    const result = canMarkRegistered({ ...fullPrereqs, auth_form_url: null })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Authorisation form must be uploaded.')
  })

  it('missing waste_location_notes → error', () => {
    const result = canMarkRegistered({ ...fullPrereqs, waste_location_notes: null })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Waste location notes are required.')
  })

  it('whitespace-only waste_location_notes → error', () => {
    const result = canMarkRegistered({ ...fullPrereqs, waste_location_notes: '   ' })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Waste location notes are required.')
  })

  it('missing collection_cadence → error', () => {
    const result = canMarkRegistered({ ...fullPrereqs, collection_cadence: null })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Collection cadence must be set.')
  })

  it('multiple missing fields → all errors collected', () => {
    const result = canMarkRegistered({
      ...fullPrereqs,
      strata_contact_id: null,
      auth_form_url: null,
      waste_location_notes: null,
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(3)
  })
})
