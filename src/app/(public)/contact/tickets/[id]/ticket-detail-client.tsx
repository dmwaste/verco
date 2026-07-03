'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { invokeEfWithUserToken } from '@/lib/supabase/invoke-ef-client'
import { getStatusStyle } from '@/lib/ui/status-styles'
import type { Database } from '@/lib/supabase/types'

type TicketStatus = Database['public']['Enums']['ticket_status']
type TicketCategory = Database['public']['Enums']['ticket_category']


const CATEGORY_LABELS: Record<TicketCategory, string> = {
  general: 'General',
  booking: 'Booking Enquiry',
  billing: 'Billing',
  service: 'Service Issue',
  complaint: 'Complaint',
  other: 'Other',
}

interface TicketData {
  id: string
  displayId: string
  subject: string
  message: string
  status: TicketStatus
  category: TicketCategory
  createdAt: string
}

interface ResponseData {
  id: string
  authorType: 'staff' | 'resident'
  authorName: string | null
  message: string
  createdAt: string
}

interface LinkedBooking {
  ref: string
  address: string
  collectionDate: string | null
  services: string[]
}

interface TicketDetailClientProps {
  ticket: TicketData
  responses: ResponseData[]
  linkedBooking: LinkedBooking | null
}

export function TicketDetailClient({
  ticket,
  responses: initialResponses,
  linkedBooking,
}: TicketDetailClientProps) {
  const supabase = createClient()
  const [responses, setResponses] = useState(initialResponses)
  const [replyText, setReplyText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [ticketStatus, setTicketStatus] = useState(ticket.status)
  const threadEndRef = useRef<HTMLDivElement>(null)

  const isClosed = ticketStatus === 'closed' || ticketStatus === 'resolved'
  const statusStyle = getStatusStyle('ticket', ticketStatus)

  // Scroll to bottom of thread when responses change
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [responses.length])

  async function handleSendReply() {
    if (!replyText.trim() || isSending) return
    setIsSending(true)
    setSendError(null)

    try {
      const efResult = await invokeEfWithUserToken<{ id: string; created_at: string }>(
        supabase,
        'create-ticket-response',
        { ticket_id: ticket.id, message: replyText.trim() }
      )

      if (!efResult.ok) {
        setSendError(efResult.error)
        setIsSending(false)
        return
      }

      const result = efResult.data

      // Optimistically append the new message
      setResponses((prev) => [
        ...prev,
        {
          id: result.id,
          authorType: 'resident' as const,
          authorName: null,
          message: replyText.trim(),
          createdAt: result.created_at,
        },
      ])

      // If ticket was waiting_on_customer, it's now open
      if (ticketStatus === 'waiting_on_customer') {
        setTicketStatus('open')
      }

      setReplyText('')
    } catch {
      setSendError('An unexpected error occurred. Please try again.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="flex flex-col">
      {/* Back link */}
      <Link
        href="/dashboard"
        className="mb-4 flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8]"
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
        My Dashboard
      </Link>

      {/* Two-column layout — sidebar only shown when linked booking exists */}
      <div className={`flex flex-col gap-4 ${linkedBooking ? 'md:flex-row' : ''}`}>
        {/* LEFT COLUMN */}
        <div className={`flex flex-1 flex-col gap-4 ${linkedBooking ? 'md:w-2/3' : 'md:max-w-3xl'}`}>
          {/* Ticket header card */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-body-sm text-gray-400">
                {ticket.displayId}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-semibold ${statusStyle.bg} ${statusStyle.text}`}
              >
                <span
                  className={`size-1.5 rounded-full ${statusStyle.dot}`}
                />
                {statusStyle.label}
              </span>
            </div>
            <h1 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)] md:text-xl">
              {ticket.subject}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-gray-200 px-2.5 py-0.5 text-caption text-gray-500">
                {CATEGORY_LABELS[ticket.category]}
              </span>
              <span className="text-caption text-gray-400">
                Opened{' '}
                {format(new Date(ticket.createdAt), "d MMM yyyy 'at' h:mmaaa")}
              </span>
            </div>
          </div>

          {/* Message thread */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-4 text-2xs font-semibold uppercase tracking-wide text-gray-500">
              Conversation
            </div>

            <div className="flex flex-col gap-3">
              {/* Original message — always resident, right-aligned */}
              <div className="flex justify-end">
                <div className="max-w-[85%]">
                  <div className="rounded-2xl rounded-br-md bg-[var(--brand-accent-light)] px-4 py-3">
                    <p className="whitespace-pre-wrap text-body-sm leading-relaxed text-[var(--brand)]">
                      {ticket.message}
                    </p>
                  </div>
                  <div className="mt-1 text-right text-caption text-gray-400">
                    {format(
                      new Date(ticket.createdAt),
                      "d MMM yyyy, h:mmaaa"
                    )}
                  </div>
                </div>
              </div>

              {/* Responses */}
              {responses.map((resp) => {
                const isResident = resp.authorType === 'resident'

                return (
                  <div
                    key={resp.id}
                    className={`flex ${isResident ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className="max-w-[85%]">
                      {!isResident && resp.authorName && (
                        <div className="mb-1 text-caption font-medium text-gray-400">
                          {resp.authorName}
                        </div>
                      )}
                      <div
                        className={`px-4 py-3 ${
                          isResident
                            ? 'rounded-2xl rounded-br-md bg-[var(--brand-accent-light)]'
                            : 'rounded-2xl rounded-bl-md bg-[#F5F5F5]'
                        }`}
                      >
                        <p className="whitespace-pre-wrap text-body-sm leading-relaxed text-[var(--brand)]">
                          {resp.message}
                        </p>
                      </div>
                      <div
                        className={`mt-1 text-caption text-gray-400 ${
                          isResident ? 'text-right' : 'text-left'
                        }`}
                      >
                        {format(
                          new Date(resp.createdAt),
                          "d MMM yyyy, h:mmaaa"
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}

              <div ref={threadEndRef} />
            </div>
          </div>

          {/* Reply box */}
          {!isClosed ? (
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Write a reply..."
                rows={3}
                className="w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-300 focus:border-[var(--brand)] focus:bg-white"
              />
              {sendError && (
                <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-body-sm text-red-700">
                  {sendError}
                </div>
              )}
              <button
                type="button"
                onClick={handleSendReply}
                disabled={isSending || !replyText.trim()}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand-accent)] px-3.5 py-3 font-[family-name:var(--font-heading)] text-body font-semibold text-[var(--brand)] transition-opacity hover:opacity-90 disabled:opacity-50 md:ml-auto md:w-auto md:px-5"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                {isSending ? 'Sending...' : 'Send Reply'}
              </button>
            </div>
          ) : (
            <div className="rounded-xl bg-gray-50 px-5 py-4 text-center text-sm text-gray-500">
              This enquiry has been {ticketStatus}. If you need further help,{' '}
              <Link
                href="/contact"
                className="font-semibold text-[var(--brand-accent-dark)] hover:underline"
              >
                submit a new enquiry
              </Link>
              .
            </div>
          )}
        </div>

        {/* RIGHT COLUMN — 1/3 sidebar, only when linked booking exists */}
        {linkedBooking && (
        <div className="flex flex-col gap-4 md:w-1/3">
          {/* Linked booking card */}
          {linkedBooking && (
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="mb-3 text-2xs font-semibold uppercase tracking-wide text-gray-500">
                Linked Booking
              </div>
              <Link
                href={`/booking/${linkedBooking.ref}`}
                className="block rounded-lg border border-gray-100 p-3 transition-colors hover:border-[var(--brand)]/20 hover:bg-gray-50"
              >
                <div className="font-[family-name:var(--font-heading)] text-xs font-semibold text-[#8FA5B8]">
                  {linkedBooking.ref}
                </div>
                {linkedBooking.address && (
                  <div className="mt-1 text-body-sm text-[var(--brand)]">
                    {linkedBooking.address}
                  </div>
                )}
                {linkedBooking.collectionDate && (
                  <div className="mt-0.5 text-[12px] text-gray-500">
                    {format(
                      new Date(linkedBooking.collectionDate + 'T00:00:00'),
                      'EEE d MMM yyyy'
                    )}
                  </div>
                )}
                {linkedBooking.services.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {linkedBooking.services.map((svc) => (
                      <span
                        key={svc}
                        className="rounded-full bg-[#E8EEF2] px-2 py-0.5 text-2xs font-medium text-[var(--brand)]"
                      >
                        {svc}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-caption font-semibold text-[var(--brand-accent-dark)]">
                  View booking &rarr;
                </div>
              </Link>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
