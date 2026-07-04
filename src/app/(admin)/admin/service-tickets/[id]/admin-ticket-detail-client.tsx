'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { getStatusStyle } from '@/lib/ui/status-styles'
import type { Database } from '@/lib/supabase/types'
import type { ResolvedAuditEntry } from '@/lib/audit/resolve'
import { AuditTimeline } from '@/components/audit-timeline'
import { BackLink } from '@/components/admin/back-link'

type TicketStatus = Database['public']['Enums']['ticket_status']
type TicketPriority = Database['public']['Enums']['ticket_priority']
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
  priority: TicketPriority
  category: TicketCategory
  channel: string
  assignedTo: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  closedAt: string | null
}

interface ContactData {
  id: string
  full_name: string
  email: string
  mobile_e164: string | null
}

interface ResponseData {
  id: string
  authorType: 'staff' | 'resident'
  authorName: string
  message: string
  isInternal: boolean
  createdAt: string
}

interface LinkedBooking {
  id: string
  ref: string
  address: string
  collectionDate: string | null
  services: string[]
}

interface StaffUser {
  id: string
  name: string
}

interface AdminTicketDetailClientProps {
  ticket: TicketData
  contact: ContactData | null
  responses: ResponseData[]
  staffUsers: StaffUser[]
  linkedBooking: LinkedBooking | null
  auditLogs: ResolvedAuditEntry[]
}

export function AdminTicketDetailClient({
  ticket,
  contact,
  responses: initialResponses,
  staffUsers,
  linkedBooking,
  auditLogs,
}: AdminTicketDetailClientProps) {
  const supabase = createClient()
  const router = useRouter()

  const [responses, setResponses] = useState(initialResponses)
  const [status, setStatus] = useState(ticket.status)
  const [priority, setPriority] = useState(ticket.priority)
  const [assignedTo, setAssignedTo] = useState(ticket.assignedTo ?? '')
  const [replyText, setReplyText] = useState('')
  const [replyMode, setReplyMode] = useState<'reply' | 'internal'>('reply')
  const [isSending, setIsSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)

  const statusStyle = getStatusStyle('ticket', status)

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [responses.length])

  async function handleStatusChange(newStatus: TicketStatus) {
    setStatus(newStatus)
    const updates: Record<string, unknown> = { status: newStatus }
    if (newStatus === 'resolved') updates.resolved_at = new Date().toISOString()
    if (newStatus === 'closed') updates.closed_at = new Date().toISOString()

    await supabase.from('service_ticket').update(updates).eq('id', ticket.id)
  }

  async function handlePriorityChange(newPriority: TicketPriority) {
    setPriority(newPriority)
    await supabase.from('service_ticket').update({ priority: newPriority }).eq('id', ticket.id)
  }

  async function handleAssignChange(userId: string) {
    setAssignedTo(userId)
    await supabase
      .from('service_ticket')
      .update({ assigned_to: userId || null })
      .eq('id', ticket.id)
  }

  async function handleSendReply() {
    if (!replyText.trim() || isSending) return
    setIsSending(true)
    setSendError(null)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setSendError('Not authenticated')
      setIsSending(false)
      return
    }

    const { data: response, error } = await supabase
      .from('ticket_response')
      .insert({
        ticket_id: ticket.id,
        author_id: user.id,
        author_type: 'staff',
        message: replyText.trim(),
        is_internal: replyMode === 'internal',
        channel: 'portal',
      })
      .select('id, created_at')
      .single()

    if (error || !response) {
      setSendError(error?.message ?? 'Failed to send')
      setIsSending(false)
      return
    }

    // Fetch the user's display name for the optimistic update
    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single()

    setResponses((prev) => [
      ...prev,
      {
        id: response.id,
        authorType: 'staff',
        authorName: profile?.display_name ?? 'You',
        message: replyText.trim(),
        isInternal: replyMode === 'internal',
        createdAt: response.created_at,
      },
    ])

    // If replying to resident and ticket was open, set to waiting_on_customer
    if (replyMode === 'reply' && status === 'open') {
      await handleStatusChange('waiting_on_customer')
    }

    setReplyText('')
    setIsSending(false)
  }

  function copyToClipboard(text: string, label: string) {
    void navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  const publicResponses = responses.filter((r) => !r.isInternal)
  const internalNotes = responses.filter((r) => r.isInternal)

  return (
    <div className="flex flex-1 flex-col">
      {/* Header */}
      <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <BackLink href="/admin/service-tickets" label="Service Tickets" />
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[#293F52]">
              {ticket.subject}
            </h1>
            <p className="mt-0.5 font-mono text-body-sm text-gray-400">{ticket.displayId}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption font-semibold ${statusStyle.bg} ${statusStyle.text}`}>
            {statusStyle.label}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-7 py-5">
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* LEFT COLUMN — 2/3 */}
        <div className="flex flex-1 flex-col gap-4 lg:w-2/3">
          {/* Ticket meta */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-gray-200 px-2.5 py-0.5 text-caption text-gray-500">
                {CATEGORY_LABELS[ticket.category]}
              </span>
              <span className="text-caption text-gray-400">
                Opened {format(new Date(ticket.createdAt), "d MMM yyyy 'at' h:mmaaa")}
              </span>
              {contact && (
                <span className="text-caption text-gray-400">
                  by <strong className="text-[#293F52]">{contact.full_name}</strong>
                </span>
              )}
            </div>
          </div>

          {/* Conversation thread */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-4 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Conversation
            </div>
            <div className="flex flex-col gap-3">
              {/* Original message */}
              <div className="flex justify-end">
                <div className="max-w-[85%]">
                  {contact && (
                    <div className="mb-1 text-right text-caption font-medium text-gray-400">
                      {contact.full_name}
                    </div>
                  )}
                  <div className="rounded-2xl rounded-br-md bg-[#E8FDF0] px-4 py-3">
                    <p className="whitespace-pre-wrap text-body-sm leading-relaxed text-[#293F52]">
                      {ticket.message}
                    </p>
                  </div>
                  <div className="mt-1 text-right text-caption text-gray-400">
                    {format(new Date(ticket.createdAt), "d MMM yyyy, h:mmaaa")}
                  </div>
                </div>
              </div>

              {/* Public responses */}
              {publicResponses.map((resp) => {
                const isResident = resp.authorType === 'resident'
                return (
                  <div key={resp.id} className={`flex ${isResident ? 'justify-end' : 'justify-start'}`}>
                    <div className="max-w-[85%]">
                      <div className={`mb-1 text-caption font-medium text-gray-400 ${isResident ? 'text-right' : 'text-left'}`}>
                        {resp.authorName}
                      </div>
                      <div className={`px-4 py-3 ${isResident ? 'rounded-2xl rounded-br-md bg-[#E8FDF0]' : 'rounded-2xl rounded-bl-md bg-[#F5F5F5]'}`}>
                        <p className="whitespace-pre-wrap text-body-sm leading-relaxed text-[#293F52]">{resp.message}</p>
                      </div>
                      <div className={`mt-1 text-caption text-gray-400 ${isResident ? 'text-right' : 'text-left'}`}>
                        {format(new Date(resp.createdAt), "d MMM yyyy, h:mmaaa")}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={threadEndRef} />
            </div>
          </div>

          {/* Internal notes */}
          {internalNotes.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-5">
              <div className="mb-4 text-caption font-semibold uppercase tracking-wide text-amber-600">
                Internal Notes
              </div>
              <div className="flex flex-col gap-3">
                {internalNotes.map((note) => (
                  <div key={note.id} className="flex justify-start">
                    <div className="max-w-[85%]">
                      <div className="mb-1 text-caption font-medium text-amber-600">
                        {note.authorName} &middot; Internal note
                      </div>
                      <div className="rounded-2xl rounded-bl-md border border-amber-200 bg-white px-4 py-3">
                        <p className="whitespace-pre-wrap text-body-sm leading-relaxed text-[#293F52]">{note.message}</p>
                      </div>
                      <div className="mt-1 text-caption text-amber-500">
                        {format(new Date(note.createdAt), "d MMM yyyy, h:mmaaa")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reply box */}
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="mb-3 flex gap-1">
              <button
                type="button"
                onClick={() => setReplyMode('reply')}
                className={`rounded-lg px-3 py-1.5 text-body-sm font-medium transition-colors ${
                  replyMode === 'reply'
                    ? 'bg-[#293F52] text-white'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                Reply to Resident
              </button>
              <button
                type="button"
                onClick={() => setReplyMode('internal')}
                className={`rounded-lg px-3 py-1.5 text-body-sm font-medium transition-colors ${
                  replyMode === 'internal'
                    ? 'bg-amber-500 text-white'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                Internal Note
              </button>
            </div>
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={replyMode === 'reply' ? 'Write a reply to the resident...' : 'Add an internal note (not visible to resident)...'}
              rows={3}
              className={`w-full resize-none rounded-[10px] border-[1.5px] px-3.5 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-300 ${
                replyMode === 'internal'
                  ? 'border-amber-200 bg-amber-50 focus:border-amber-400'
                  : 'border-gray-100 bg-gray-50 focus:border-[#293F52] focus:bg-white'
              }`}
            />
            {sendError && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-body-sm text-red-700">{sendError}</div>
            )}
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={handleSendReply}
                disabled={isSending || !replyText.trim()}
                className={`flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 font-[family-name:var(--font-heading)] text-body-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${
                  replyMode === 'internal'
                    ? 'bg-amber-500 text-white'
                    : 'bg-[#00E47C] text-[#293F52]'
                }`}
              >
                {isSending ? 'Sending...' : replyMode === 'reply' ? 'Send Reply' : 'Add Internal Note'}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN — 1/3 sidebar */}
        <div className="flex flex-col gap-4 lg:w-1/3">
          {/* Status & Priority controls */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Manage
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="mb-1 block text-caption font-medium text-gray-400">Status</label>
                <select
                  value={status}
                  onChange={(e) => handleStatusChange(e.target.value as TicketStatus)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="waiting_on_customer">Waiting on Customer</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-caption font-medium text-gray-400">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => handlePriorityChange(e.target.value as TicketPriority)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-caption font-medium text-gray-400">Assign to</label>
                <select
                  value={assignedTo}
                  onChange={(e) => handleAssignChange(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                >
                  <option value="">Unassigned</option>
                  {staffUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Ticket metadata */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
              Details
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-body-sm">
                <span className="text-gray-400">Ticket</span>
                <span className="font-mono text-gray-600">{ticket.displayId}</span>
              </div>
              <div className="flex justify-between text-body-sm">
                <span className="text-gray-400">Category</span>
                <span className="text-gray-600">{CATEGORY_LABELS[ticket.category]}</span>
              </div>
              <div className="flex justify-between text-body-sm">
                <span className="text-gray-400">Channel</span>
                <span className="capitalize text-gray-600">{ticket.channel}</span>
              </div>
              <div className="flex justify-between text-body-sm">
                <span className="text-gray-400">Opened</span>
                <span className="text-gray-600">{format(new Date(ticket.createdAt), 'd MMM yyyy')}</span>
              </div>
              <div className="flex justify-between text-body-sm">
                <span className="text-gray-400">Updated</span>
                <span className="text-gray-600">{format(new Date(ticket.updatedAt), 'd MMM yyyy')}</span>
              </div>
            </div>
          </div>

          {/* Resident card */}
          {contact && (
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
                Resident
              </div>
              <div className="flex flex-col gap-2">
                <div>
                  <div className="text-caption text-gray-400">Name</div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(contact.full_name, 'name')}
                    className="mt-0.5 text-body-sm font-medium text-[#293F52] hover:underline"
                    title="Click to copy"
                  >
                    {contact.full_name}
                    {copied === 'name' && <span className="ml-1 text-2xs text-emerald-500">Copied</span>}
                  </button>
                </div>
                <div>
                  <div className="text-caption text-gray-400">Email</div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(contact.email, 'email')}
                    className="mt-0.5 text-body-sm font-medium text-[#293F52] hover:underline"
                    title="Click to copy"
                  >
                    {contact.email}
                    {copied === 'email' && <span className="ml-1 text-2xs text-emerald-500">Copied</span>}
                  </button>
                </div>
                {contact.mobile_e164 && (
                  <div>
                    <div className="text-caption text-gray-400">Mobile</div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(contact.mobile_e164!, 'mobile')}
                      className="mt-0.5 text-body-sm font-medium text-[#293F52] hover:underline"
                      title="Click to copy"
                    >
                      {contact.mobile_e164}
                      {copied === 'mobile' && <span className="ml-1 text-2xs text-emerald-500">Copied</span>}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Linked booking */}
          {linkedBooking && (
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">
                Linked Booking
              </div>
              <Link
                href={`/admin/bookings/${linkedBooking.id}`}
                className="block rounded-lg border border-gray-100 p-3 transition-colors hover:border-[#293F52]/20 hover:bg-gray-50"
              >
                <div className="font-[family-name:var(--font-heading)] text-xs font-semibold text-[#8FA5B8]">
                  {linkedBooking.ref}
                </div>
                {linkedBooking.address && (
                  <div className="mt-1 text-body-sm text-[#293F52]">{linkedBooking.address}</div>
                )}
                {linkedBooking.collectionDate && (
                  <div className="mt-0.5 text-xs text-gray-500">
                    {format(new Date(linkedBooking.collectionDate + 'T00:00:00'), 'EEE d MMM yyyy')}
                  </div>
                )}
                {linkedBooking.services.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {linkedBooking.services.map((svc) => (
                      <span key={svc} className="rounded-full bg-[#E8EEF2] px-2 py-0.5 text-2xs font-medium text-[#293F52]">{svc}</span>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-caption font-semibold text-[#00B864]">View booking &rarr;</div>
              </Link>
            </div>
          )}

          {/* Audit trail */}
          {auditLogs.length > 0 && (
            <div className="rounded-xl bg-white shadow-sm">
              <AuditTimeline entries={auditLogs} />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
