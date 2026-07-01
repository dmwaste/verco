import { describe, it, expect } from 'vitest'
import {
  classifyCreator,
  CREATOR_STAFF_ROLES,
  type CreatedVia,
} from '@/lib/bookings/classify-creator'

describe('classifyCreator', () => {
  // --- resident: no acting user (guest / no session) ----------------------
  it('guest OTP self-booking (no session, null role + email) → resident', () => {
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: null,
        contactEmail: 'jane@resident.com',
        hasSession: false,
      }).createdVia,
    ).toBe('resident')
  })

  it('no session but stray role/email present → still resident (no acting user)', () => {
    // hasSession=false is authoritative: there is no acting user, so it is a
    // resident self-booking regardless of any leftover fields.
    expect(
      classifyCreator({
        actingUserRole: 'contractor-admin',
        actingUserEmail: 'staff@dmwaste.com',
        contactEmail: 'jane@resident.com',
        hasSession: false,
      }).createdVia,
    ).toBe('resident')
  })

  it('null everything (no session implied) → resident', () => {
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: null,
        contactEmail: null,
        hasSession: false,
      }).createdVia,
    ).toBe('resident')
  })

  // --- resident: authed user booking for their own email ------------------
  it('authed resident booking for own email → resident', () => {
    expect(
      classifyCreator({
        actingUserRole: 'resident',
        actingUserEmail: 'jane@resident.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('resident')
  })

  it('authed user with no role booking for own email → resident', () => {
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: 'jane@resident.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('resident')
  })

  it('email match is case-insensitive and whitespace-trimmed → resident', () => {
    expect(
      classifyCreator({
        actingUserRole: 'resident',
        actingUserEmail: '  Jane@Resident.com ',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('resident')
  })

  // --- admin: staff role (role wins regardless of email) ------------------
  it('staff on-behalf booking for a resident (email mismatch) → admin', () => {
    expect(
      classifyCreator({
        actingUserRole: 'contractor-admin',
        actingUserEmail: 'staff@dmwaste.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })

  it('client-staff role with matching email is still admin (staff role wins)', () => {
    expect(
      classifyCreator({
        actingUserRole: 'client-staff',
        actingUserEmail: 'staff@kwinana.gov.au',
        contactEmail: 'staff@kwinana.gov.au',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })

  it.each(CREATOR_STAFF_ROLES)('staff role %s → admin', (role) => {
    expect(
      classifyCreator({
        actingUserRole: role,
        actingUserEmail: 'staff@dmwaste.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })

  // --- admin: authed non-staff booking for a DIFFERENT email --------------
  it('authed resident booking for a DIFFERENT email (collision/family) → admin', () => {
    expect(
      classifyCreator({
        actingUserRole: 'resident',
        actingUserEmail: 'someone@else.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })

  // --- ranger -------------------------------------------------------------
  it('ranger role → ranger (regardless of email match)', () => {
    expect(
      classifyCreator({
        actingUserRole: 'ranger',
        actingUserEmail: 'ranger@kwinana.gov.au',
        contactEmail: 'ranger@kwinana.gov.au',
        hasSession: true,
      }).createdVia,
    ).toBe('ranger')
  })

  it('ranger role with email mismatch → ranger (role wins over admin email path)', () => {
    expect(
      classifyCreator({
        actingUserRole: 'ranger',
        actingUserEmail: 'ranger@kwinana.gov.au',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('ranger')
  })

  // --- system: authed, no useful signal -----------------------------------
  it('authed session, no role, no acting email, no contact email → system', () => {
    // A session exists (so not a guest resident), but there is no email to
    // compare and no role to classify by — fall through to system.
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: null,
        contactEmail: null,
        hasSession: true,
      }).createdVia,
    ).toBe('system')
  })

  it('authed session, no role, acting email present but no contact email → system', () => {
    // Cannot establish an email match (no contact email) and no role signal.
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: 'someone@else.com',
        contactEmail: null,
        hasSession: true,
      }).createdVia,
    ).toBe('system')
  })

  it('authed session, no role, no acting email, contact email present → system', () => {
    // Cannot match (no acting email) and no role — fall through to system.
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: null,
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('system')
  })

  // --- invalid / unknown role inputs --------------------------------------
  it('unknown role string with email match → resident (email path applies)', () => {
    expect(
      classifyCreator({
        actingUserRole: 'banana',
        actingUserEmail: 'jane@resident.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('resident')
  })

  it('unknown role string with email mismatch → admin (acting-on-behalf path)', () => {
    expect(
      classifyCreator({
        actingUserRole: 'banana',
        actingUserEmail: 'someone@else.com',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('admin')
  })

  it('empty-string emails are treated as absent → system when authed with no role', () => {
    expect(
      classifyCreator({
        actingUserRole: null,
        actingUserEmail: '',
        contactEmail: '',
        hasSession: true,
      }).createdVia,
    ).toBe('system')
  })

  it('empty-string acting email, contact email present, authed, no role → system', () => {
    expect(
      classifyCreator({
        actingUserRole: '   ',
        actingUserEmail: '',
        contactEmail: 'jane@resident.com',
        hasSession: true,
      }).createdVia,
    ).toBe('system')
  })

  // --- return shape -------------------------------------------------------
  it('returns an object with a single createdVia field', () => {
    const result = classifyCreator({
      actingUserRole: null,
      actingUserEmail: null,
      contactEmail: null,
      hasSession: false,
    })
    expect(result).toEqual({ createdVia: 'resident' })
  })

  it('CreatedVia type covers all four channels (compile-time + value check)', () => {
    const all: CreatedVia[] = ['resident', 'admin', 'ranger', 'system']
    expect(new Set(all).size).toBe(4)
  })
})
