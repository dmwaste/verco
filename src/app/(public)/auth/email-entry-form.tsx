'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendOtp } from './actions'
import { VercoButton } from '@/components/ui/verco-button'

export function EmailEntryForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setIsPending(true)

    const result = await sendOtp(email)

    if (!result.ok) {
      setError(result.error)
      setIsPending(false)
      return
    }

    // Encode email in URL so verify page can display it
    const params = new URLSearchParams({ email })
    router.push(`/auth/verify?${params.toString()}`)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-gray-100 bg-white p-7 shadow-lg"
    >
      <div>
        <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)]">
          Sign in
        </h1>
        <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
          Enter your email address and we&apos;ll send you a one-time code to
          sign in.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="email"
          className="text-xs font-medium text-gray-700"
        >
          Email address
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={`w-full rounded-[10px] border-[1.5px] bg-gray-50 px-3.5 py-3 text-body text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-[var(--brand)] focus:border-2 focus:bg-white ${
            error ? 'border-red-500 bg-red-50' : 'border-gray-100'
          }`}
        />
        {error && (
          <p className="flex items-center gap-1 text-caption text-red-500">
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
            {error}
          </p>
        )}
      </div>

      <VercoButton
        type="submit"
        disabled={isPending}
        className="w-full"
      >
        {isPending ? 'Sending...' : 'Send Code'}
        {!isPending && (
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
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        )}
      </VercoButton>

      <div className="flex items-start gap-2 rounded-lg bg-gray-50 p-2.5 text-caption leading-snug text-gray-500">
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
        We use passwordless sign-in for your security. No password required
        &mdash; ever.
      </div>
    </form>
  )
}
