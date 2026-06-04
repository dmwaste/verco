'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { sendOtp } from '../actions'

type VerifyState = 'idle' | 'verifying' | 'success' | 'error'

const OTP_LENGTH = 6
const RESEND_COOLDOWN_SECONDS = 30

interface OtpVerifyFormProps {
  postLoginPath: string
}

export function OtpVerifyForm({ postLoginPath }: OtpVerifyFormProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const email = searchParams.get('email') ?? ''

  const [digits, setDigits] = useState<string[]>(Array.from({ length: OTP_LENGTH }, () => ''))
  const [state, setState] = useState<VerifyState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SECONDS)
  const [isResending, setIsResending] = useState(false)

  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  // Countdown timer for resend cooldown
  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setInterval(() => {
      setResendCooldown((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [resendCooldown])

  // Focus the first empty cell on mount
  useEffect(() => {
    inputRefs.current[0]?.focus()
  }, [])

  const verifyCode = useCallback(
    async (code: string) => {
      setState('verifying')
      setErrorMessage(null)

      const supabase = createClient()
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: 'email',
      })

      if (error) {
        setState('error')
        setErrorMessage('Invalid code. Please try again or request a new one.')
        return
      }

      setState('success')
      // Brief delay so the user sees the success state
      setTimeout(() => {
        router.push(postLoginPath)
      }, 1200)
    },
    [email, router, postLoginPath]
  )

  function handleDigitChange(index: number, value: string) {
    // Only allow single digits
    const digit = value.replace(/\D/g, '').slice(-1)

    const next = [...digits]
    next[index] = digit
    setDigits(next)

    // Clear error state when user starts typing again
    if (state === 'error') {
      setState('idle')
      setErrorMessage(null)
    }

    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus()
    }

    // Auto-submit when all digits filled
    if (digit && index === OTP_LENGTH - 1) {
      const code = next.join('')
      if (code.length === OTP_LENGTH) {
        void verifyCode(code)
      }
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
      const next = [...digits]
      next[index - 1] = ''
      setDigits(next)
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH)
    if (!pasted) return

    const next = Array.from({ length: OTP_LENGTH }, (_, i) => pasted[i] ?? '')
    setDigits(next)

    if (state === 'error') {
      setState('idle')
      setErrorMessage(null)
    }

    // Focus last filled cell or submit
    const lastFilledIndex = Math.min(pasted.length, OTP_LENGTH) - 1
    inputRefs.current[lastFilledIndex]?.focus()

    if (pasted.length === OTP_LENGTH) {
      void verifyCode(pasted)
    }
  }

  async function handleResend() {
    if (resendCooldown > 0 || isResending) return
    setIsResending(true)

    const result = await sendOtp(email)

    setIsResending(false)
    if (result.ok) {
      setResendCooldown(RESEND_COOLDOWN_SECONDS)
      setDigits(Array.from({ length: OTP_LENGTH }, () => ''))
      setState('idle')
      setErrorMessage(null)
      inputRefs.current[0]?.focus()
    } else {
      setErrorMessage(result.error)
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const code = digits.join('')
    if (code.length === OTP_LENGTH) {
      void verifyCode(code)
    }
  }

  function getCellClassName(index: number): string {
    const base =
      'flex size-[52px] h-[60px] items-center justify-center rounded-[10px] border-[1.5px] text-center font-[family-name:var(--font-heading)] text-2xl font-bold outline-none transition-colors'

    if (state === 'success') {
      return `${base} border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] text-[var(--brand-accent-dark)]`
    }
    if (state === 'error') {
      return `${base} border-red-500 bg-red-50 text-red-500`
    }
    if (digits[index]) {
      return `${base} border-[var(--brand)] bg-white text-[var(--brand)]`
    }
    return `${base} border-gray-100 bg-gray-50 text-[var(--brand)] focus:border-[var(--brand)] focus:border-2 focus:bg-white`
  }

  const minutesLeft = Math.floor(resendCooldown / 60)
  const secondsLeft = resendCooldown % 60
  const countdownText = `${minutesLeft}:${secondsLeft.toString().padStart(2, '0')}`

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-gray-100 bg-white p-7 shadow-lg"
    >
      {/* Back link */}
      <button
        type="button"
        onClick={() => router.push('/auth')}
        className="flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8]"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Change email
      </button>

      {/* Title */}
      {state === 'success' ? (
        <div className="text-center">
          <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-[var(--brand-accent-light)]">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--brand-accent-dark)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)]">
            You&apos;re signed in
          </h1>
          <p className="mt-1.5 text-body-sm text-gray-500">
            Taking you to your dashboard now.
          </p>
        </div>
      ) : (
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)]">
            Check your email
          </h1>
          <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
            We sent a 6-digit code to
            <br />
            <strong className="text-[var(--brand)]">{email}</strong>
          </p>
        </div>
      )}

      {/* OTP cells */}
      <div className="flex flex-col gap-3">
        <div className="flex justify-center gap-2">
          {digits.map((digit, i) => (
            <input
              key={i}
              ref={(el) => { inputRefs.current[i] = el }}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={1}
              value={digit}
              disabled={state === 'verifying' || state === 'success'}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleKeyDown(i, e)}
              onPaste={i === 0 ? handlePaste : undefined}
              className={getCellClassName(i)}
            />
          ))}
        </div>

        {state === 'error' && errorMessage && (
          <p className="flex items-center justify-center gap-1 text-[11px] text-red-500">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {errorMessage}
          </p>
        )}

        {state === 'success' && (
          <div className="overflow-hidden rounded-sm bg-gray-100">
            <div className="h-1 w-[70%] animate-pulse rounded-sm bg-[var(--brand-accent-dark)]" />
          </div>
        )}

        {state !== 'error' && state !== 'success' && (
          <p className="text-center text-body-sm text-gray-500">
            Enter the 6-digit code from your email
          </p>
        )}
      </div>

      {/* Submit / retry button */}
      {state !== 'success' && (
        <button
          type="submit"
          disabled={state === 'verifying' || digits.join('').length < OTP_LENGTH}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand)] px-3.5 py-3.5 font-[family-name:var(--font-heading)] text-body font-semibold text-white transition-opacity hover:opacity-90 active:opacity-85 disabled:opacity-50"
        >
          {state === 'verifying' ? (
            'Verifying...'
          ) : state === 'error' ? (
            'Try Again'
          ) : (
            <>
              Verify Code
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </>
          )}
        </button>
      )}

      {/* Countdown / resend */}
      {state !== 'success' && (
        <div className="text-center text-body-sm text-gray-500">
          {resendCooldown > 0 ? (
            <>
              You can request a new code in{' '}
              <strong className="text-[var(--brand)]">{countdownText}</strong>
            </>
          ) : (
            <button
              type="button"
              onClick={handleResend}
              disabled={isResending}
              className="font-semibold text-[var(--brand-accent-dark)] hover:underline disabled:text-gray-300"
            >
              {isResending ? 'Sending...' : 'Request a new code'}
            </button>
          )}
        </div>
      )}

      {/* Security note */}
      {state !== 'success' && (
        <div className="flex items-start gap-2 rounded-lg bg-gray-50 p-2.5 text-[11px] leading-snug text-gray-500">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-px shrink-0 text-gray-400"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Didn&apos;t get the email? Check your spam folder or wait 30 seconds
          before requesting a new code.
        </div>
      )}
    </form>
  )
}
