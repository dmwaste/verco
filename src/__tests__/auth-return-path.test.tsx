// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * VER-316: an expired session must not drop the caller's number. The login
 * flow carries `next` from /auth → /auth/verify → back to the lookup, and only
 * a same-host path is ever honoured.
 */

const { push, sendOtp, host } = vi.hoisted(() => ({
  push: vi.fn(),
  sendOtp: vi.fn(),
  host: { value: 'admin.verco.au' },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams({ email: 'kim@example.com' }),
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: host.value }),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/app/(public)/auth/actions', () => ({ sendOtp }))

import { resolveAuthHostContext } from '@/app/(public)/auth/_host-context'
import { EmailEntryForm } from '@/app/(public)/auth/email-entry-form'
import { OtpVerifyForm } from '@/app/(public)/auth/verify/otp-verify-form'

const LOOKUP = '/admin/lookup?phone=+61412345678'

describe('resolveAuthHostContext — post-login destination', () => {
  beforeEach(() => {
    host.value = 'admin.verco.au'
  })

  it('returns to a safe next path on the admin host', async () => {
    const ctx = await resolveAuthHostContext(LOOKUP)
    expect(ctx.postLoginPath).toBe(LOOKUP)
    expect(ctx.next).toBe(LOOKUP)
  })

  it.each(['https://evil.example', '//evil.example', undefined])(
    'falls back to the host default for next=%j',
    async (next) => {
      const ctx = await resolveAuthHostContext(next)
      expect(ctx.postLoginPath).toBe('/admin')
      expect(ctx.next).toBeNull()
    },
  )

  it('falls back to /field on the field host', async () => {
    host.value = 'field.verco.au'
    expect((await resolveAuthHostContext('https://evil.example')).postLoginPath).toBe('/field')
  })
})

describe('login forms carry next', () => {
  beforeEach(() => vi.clearAllMocks())

  it('email entry hands next on to the verify step', async () => {
    sendOtp.mockResolvedValue({ ok: true, data: undefined })
    render(<EmailEntryForm next={LOOKUP} />)

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'kim@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /send code/i }))

    await waitFor(() => expect(push).toHaveBeenCalled())
    const target = new URL(push.mock.calls[0]![0] as string, 'https://admin.verco.au')
    expect(target.pathname).toBe('/auth/verify')
    expect(target.searchParams.get('email')).toBe('kim@example.com')
    expect(target.searchParams.get('next')).toBe(LOOKUP)
  })

  it('email entry without next goes to verify with the email only', async () => {
    sendOtp.mockResolvedValue({ ok: true, data: undefined })
    render(<EmailEntryForm next={null} />)

    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'kim@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /send code/i }))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/auth/verify?email=kim%40example.com'))
  })

  it('"Change email" goes back to /auth keeping next', () => {
    render(<OtpVerifyForm postLoginPath={LOOKUP} next={LOOKUP} />)

    fireEvent.click(screen.getByRole('button', { name: /change email/i }))

    expect(push).toHaveBeenCalledWith('/auth?next=%2Fadmin%2Flookup%3Fphone%3D%2B61412345678')
  })
})
