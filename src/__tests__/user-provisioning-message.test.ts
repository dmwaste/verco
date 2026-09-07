/**
 * Admin add-user outcome copy (#575 follow-up).
 *
 * Council staff routinely try the resident booking portal before they are set
 * up as staff, so "Add User" often lands on an account that already exists.
 * The EF now upgrades that account in place — the dialog has to say so rather
 * than claiming it created someone new.
 */
import { describe, it, expect } from 'vitest'
import { describeUserProvisioning } from '@/app/(admin)/admin/users/user-provisioning-message'

describe('describeUserProvisioning', () => {
  it('reports a genuinely new account with no extra notice', () => {
    expect(
      describeUserProvisioning({ existingAccount: false, previousRole: null, role: 'client-staff' }),
    ).toEqual({ title: 'User Created', notice: null })
  })

  it('explains the resident-portal case that used to fail outright', () => {
    const result = describeUserProvisioning({
      existingAccount: true,
      previousRole: 'resident',
      role: 'client-staff',
    })
    expect(result.title).toBe('Access Added')
    expect(result.notice).toBe(
      'This person already had a resident account on the booking portal. It has been given Client Staff access — no new account was created.',
    )
  })

  it('names both roles when an existing staff account changes role', () => {
    const result = describeUserProvisioning({
      existingAccount: true,
      previousRole: 'ranger',
      role: 'client-staff',
    })
    expect(result.title).toBe('Access Updated')
    expect(result.notice).toBe(
      'This person already had Client Ranger access. It has been changed to Client Staff.',
    )
  })

  it('does not claim a change when the role is unchanged', () => {
    const result = describeUserProvisioning({
      existingAccount: true,
      previousRole: 'client-staff',
      role: 'client-staff',
    })
    expect(result.title).toBe('Access Updated')
    expect(result.notice).toBe(
      'This person already had Client Staff access. Their contact details have been updated.',
    )
  })

  it('falls back to a role-less description when the account has no role row', () => {
    const result = describeUserProvisioning({
      existingAccount: true,
      previousRole: null,
      role: 'ranger',
    })
    expect(result.title).toBe('Access Added')
    expect(result.notice).toBe(
      'This person already had a Verco account. It has been given Client Ranger access — no new account was created.',
    )
  })
})
