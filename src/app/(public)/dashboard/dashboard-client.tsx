'use client'

import { useState } from 'react'
import Link from 'next/link'
import { differenceInDays, format } from 'date-fns'
import { cancellationCutoff } from '@/lib/booking/cancellation-cutoff'
import { BookingStatusBadge } from '@/components/booking/booking-status-badge'
import type { Database } from '@/lib/supabase/types'

type BookingStatus = Database['public']['Enums']['booking_status']
type TicketStatus = Database['public']['Enums']['ticket_status']

interface BookingItem {
  id: string
  no_services: number
  is_extra: boolean
  unit_price_cents: number
  service: { name: string }
  collection_date: { date: string }
}

interface Booking {
  id: string
  ref: string
  status: BookingStatus
  type: string
  location: string | null
  notes: string | null
  created_at: string
  geo_address: string | null
  collection_area: { name: string }
  eligible_properties: { formatted_address: string | null } | null
  booking_item: BookingItem[]
}

interface Ticket {
  id: string
  display_id: string
  subject: string
  status: TicketStatus
  category: string
  created_at: string
}

interface DashboardClientProps {
  displayName: string
  fyLabel: string
  bookings: Booking[]
  tickets: Ticket[]
}

const UPCOMING_STATUSES: BookingStatus[] = [
  'Pending Payment',
  'Submitted',
  'Confirmed',
  'Scheduled',
]
const PAST_STATUSES: BookingStatus[] = [
  'Completed',
  'Cancelled',
  'Non-conformance',
  'Nothing Presented',
  'Rebooked',
  'Missed Collection',
]

type Tab = 'upcoming' | 'past' | 'enquiries'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function getFirstName(name: string): string {
  return name.split(' ')[0] ?? ''
}

function getAddress(booking: Booking): string {
  const prop = booking.eligible_properties as { formatted_address: string | null } | null
  return prop?.formatted_address
    ?? booking.geo_address
    ?? (booking.collection_area as { name: string }).name
}

function getCollectionDate(booking: Booking): string | null {
  if (booking.booking_item.length === 0) return null
  return booking.booking_item[0]?.collection_date?.date ?? null
}

function getDaysUntil(dateStr: string): number {
  const target = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  return differenceInDays(target, now)
}

function getCutoffDate(collectionDateStr: string): Date {
  return cancellationCutoff(collectionDateStr)
}

function getBorderClass(status: BookingStatus): string {
  switch (status) {
    case 'Submitted':
    case 'Confirmed':
      return 'border-l-[var(--brand)]'
    case 'Scheduled':
      return 'border-l-[var(--brand-accent-dark)]'
    case 'Completed':
      return 'border-l-gray-300'
    case 'Non-conformance':
      return 'border-l-[#E53E3E]'
    case 'Nothing Presented':
      return 'border-l-[#FF8C42]'
    default:
      return 'border-l-transparent'
  }
}

const TICKET_DOT_COLORS: Partial<Record<TicketStatus, string>> = {
  open: 'bg-[#3182CE]',
  in_progress: 'bg-[#3182CE]',
  waiting_on_customer: 'bg-[#FF8C42]',
  resolved: 'bg-[var(--brand-accent-dark)]',
}

const TICKET_STATUS_LABELS: Partial<Record<TicketStatus, string>> = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting_on_customer: 'Awaiting Reply',
  resolved: 'Resolved',
  closed: 'Closed',
}

const CATEGORIES: Record<string, string> = {
  general: 'General',
  booking: 'Booking Enquiry',
  billing: 'Billing',
  service: 'Service Issue',
  complaint: 'Complaint',
  other: 'Other',
}

function BookingCard({ booking }: { booking: Booking }) {
  const collectionDateStr = getCollectionDate(booking)
  const daysUntil = collectionDateStr ? getDaysUntil(collectionDateStr) : null
  const isActive = UPCOMING_STATUSES.includes(booking.status)
  const showPlaceOut = isActive && daysUntil !== null && daysUntil >= 0 && daysUntil <= 3

  return (
    <div className="mb-3">
      {showPlaceOut && collectionDateStr && (
        <div className="mb-2.5 rounded-[10px] border border-[var(--brand-accent-dark)] bg-gradient-to-br from-[var(--brand-accent-light)] to-[#d4f5e6] px-3.5 py-3">
          <div className="mb-0.5 flex items-center gap-1.5 text-body-sm md:text-body font-semibold text-[var(--brand)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand-accent-dark)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            Place out your waste now
          </div>
          <div className="text-xs md:text-sm text-gray-700">
            Your collection is in{' '}
            <strong>
              {daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `${daysUntil} days`}
            </strong>
            . Items must be on the verge by 7am{' '}
            {format(new Date(collectionDateStr + 'T00:00:00'), 'EEEE d MMMM')}.
          </div>
        </div>
      )}

      <Link
        href={`/booking/${booking.ref}`}
        className={`block rounded-xl border-l-4 bg-white p-4 shadow-sm ${getBorderClass(booking.status)}`}
      >
        {/* Top: ref + status */}
        <div className="mb-1.5 flex items-start justify-between">
          <div className="font-[family-name:var(--font-heading)] text-xs md:text-sm font-semibold text-[#8FA5B8]">
            {booking.ref}
          </div>
          <BookingStatusBadge status={booking.status} />
        </div>

        {/* Date */}
        {collectionDateStr && (
          <div className="text-sm md:text-base font-semibold text-[var(--brand)]">
            {format(new Date(collectionDateStr + 'T00:00:00'), 'EEE d MMMM yyyy')}
          </div>
        )}

        {/* Address */}
        <div className="mt-0.5 text-xs md:text-sm text-gray-500">
          {getAddress(booking)}
        </div>

        {/* Countdown — only for active bookings */}
        {isActive && collectionDateStr && daysUntil !== null && daysUntil >= 0 && daysUntil <= 7 && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-[#E8EEF2] px-3 py-2 text-xs md:text-sm font-medium text-[var(--brand)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>
              {daysUntil === 0 ? 'Today' : daysUntil === 1 ? '1 day away' : `${daysUntil} days away`}
              {' · '}
              <strong>
                cannot cancel after {format(getCutoffDate(collectionDateStr), "h:mmaaa EEEE")}
              </strong>
            </span>
          </div>
        )}

        {/* Service chips */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {booking.booking_item.map((item) => (
            <span
              key={item.id}
              className={`inline-flex rounded-full px-2.5 py-0.5 text-caption md:text-body-sm font-medium ${
                item.is_extra ? 'bg-[#FFF3EA] text-[#8B4000]' : 'bg-[#E8EEF2] text-[var(--brand)]'
              }`}
            >
              {(item.service as { name: string }).name} &times; {item.no_services}
              {item.is_extra && ` (extra · $${((item.unit_price_cents * item.no_services) / 100).toFixed(2)})`}
            </span>
          ))}
        </div>

        {/* Bottom: location + view details */}
        <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2">
          <span className="text-xs md:text-sm text-gray-500">{booking.location}</span>
          <span className="text-xs md:text-sm font-semibold text-[var(--brand-accent-dark)]">View details &rarr;</span>
        </div>
      </Link>
    </div>
  )
}

export function DashboardClient({
  displayName,
  fyLabel,
  bookings,
  tickets,
}: DashboardClientProps) {
  const [activeTab, setActiveTab] = useState<Tab>('upcoming')
  const firstName = getFirstName(displayName)
  const greeting = getGreeting()

  const upcomingBookings = bookings.filter((b) => UPCOMING_STATUSES.includes(b.status))
  const pastBookings = bookings.filter((b) => PAST_STATUSES.includes(b.status)).slice(0, 10)
  const activeTicketCount = tickets.filter(
    (t) => t.status === 'open' || t.status === 'in_progress' || t.status === 'waiting_on_customer'
  ).length

  const tabs: { key: Tab; label: string }[] = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'past', label: 'Past' },
    { key: 'enquiries', label: 'Enquiries' },
  ]

  return (
    <div className="flex flex-col">
      {/* Header area */}
      <div className="flex flex-col gap-4 tablet:flex-row tablet:items-start tablet:justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-xl md:text-3xl font-bold text-[var(--brand)]">
            My Dashboard
          </h1>
          <p className="mt-1 text-sm md:text-base text-gray-500">
            {greeting}, {firstName || 'there'}
          </p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="mt-6 grid grid-cols-2 gap-3 tablet:grid-cols-4">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 md:size-11 items-center justify-center rounded-lg bg-[#EBF5FF]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3182CE" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </div>
            <div>
              <div className="font-[family-name:var(--font-heading)] text-xl md:text-3xl font-bold text-[var(--brand)]">
                {upcomingBookings.length}
              </div>
              <div className="text-xs md:text-sm text-gray-500">Upcoming</div>
            </div>
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 md:size-11 items-center justify-center rounded-lg bg-[var(--brand-accent-light)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand-accent-dark)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <div className="font-[family-name:var(--font-heading)] text-xl md:text-3xl font-bold text-[var(--brand)]">
                {pastBookings.filter((b) => b.status === 'Completed').length}
              </div>
              <div className="text-xs md:text-sm text-gray-500">Completed</div>
            </div>
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 md:size-11 items-center justify-center rounded-lg bg-[#F3EEFF]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#805AD5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" />
              </svg>
            </div>
            <div>
              <div className="font-[family-name:var(--font-heading)] text-xl md:text-3xl font-bold text-[var(--brand)]">
                {bookings.length}
              </div>
              <div className="text-xs md:text-sm text-gray-500">Total {fyLabel}</div>
            </div>
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 md:size-11 items-center justify-center rounded-lg bg-[#FFF3EA]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF8C42" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <div className="font-[family-name:var(--font-heading)] text-xl md:text-3xl font-bold text-[var(--brand)]">
                {activeTicketCount}
              </div>
              <div className="text-xs md:text-sm text-gray-500">Active Enquiries</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-gray-200 pb-px">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`shrink-0 rounded-t-lg px-4 py-2.5 text-sm md:text-base font-medium transition-colors ${
              activeTab === tab.key
                ? 'border-b-2 border-[var(--brand)] text-[var(--brand)]'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="mt-4">
        {activeTab === 'upcoming' && (
          <>
            {upcomingBookings.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-8 text-center shadow-sm">
                <div className="flex size-12 items-center justify-center rounded-full bg-gray-100">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </div>
                <span className="text-sm md:text-base font-semibold text-[var(--brand)]">
                  No upcoming bookings
                </span>
                <span className="text-xs md:text-sm text-gray-500">
                  You haven&apos;t booked a collection yet for this financial year.
                </span>
                <Link
                  href="/book"
                  className="mt-2 rounded-lg bg-[var(--brand-accent)] px-5 py-2.5 font-[family-name:var(--font-heading)] text-sm md:text-base font-semibold text-[var(--brand)]"
                >
                  Book a Collection
                </Link>
              </div>
            ) : (
              upcomingBookings.map((booking) => (
                <BookingCard key={booking.id} booking={booking} />
              ))
            )}
          </>
        )}

        {activeTab === 'past' && (
          <>
            {pastBookings.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-8 text-center shadow-sm">
                <span className="text-sm md:text-base font-semibold text-[var(--brand)]">No past bookings</span>
                <span className="text-xs md:text-sm text-gray-500">Completed bookings will appear here.</span>
              </div>
            ) : (
              pastBookings.map((booking) => (
                <BookingCard key={booking.id} booking={booking} />
              ))
            )}
          </>
        )}

        {activeTab === 'enquiries' && (
          <>
            {tickets.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl bg-white p-8 text-center shadow-sm">
                <div className="flex size-12 items-center justify-center rounded-full bg-gray-100">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <span className="text-sm md:text-base font-semibold text-[var(--brand)]">No enquiries yet</span>
                <span className="text-xs md:text-sm text-gray-500">Need help? Submit an enquiry and we&apos;ll get back to you.</span>
                <Link
                  href="/contact"
                  className="mt-2 rounded-lg bg-[var(--brand)] px-5 py-2.5 font-[family-name:var(--font-heading)] text-sm md:text-base font-semibold text-white"
                >
                  Contact Us
                </Link>
              </div>
            ) : (
              tickets.map((ticket) => (
                <Link
                  key={ticket.id}
                  href={`/contact/tickets/${ticket.display_id}`}
                  className="mb-2.5 block rounded-xl bg-white p-4 shadow-sm transition-colors hover:bg-gray-50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 font-[family-name:var(--font-heading)] text-xs md:text-sm font-semibold text-[#8FA5B8]">
                        {ticket.display_id}
                      </div>
                      <div className="text-body-sm md:text-body font-semibold text-[var(--brand)]">
                        {ticket.subject}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <span className="inline-flex rounded-full bg-[#E8EEF2] px-2.5 py-0.5 text-caption md:text-body-sm font-medium text-[var(--brand)]">
                          {CATEGORIES[ticket.category] ?? ticket.category}
                        </span>
                        <span className="text-caption md:text-body-sm text-gray-500">
                          {format(new Date(ticket.created_at), 'd MMM yyyy')}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-1.5">
                        <div
                          className={`size-2 rounded-full ${
                            TICKET_DOT_COLORS[ticket.status] ?? 'bg-gray-300'
                          }`}
                        />
                        <span className="text-xs font-medium text-gray-600">
                          {TICKET_STATUS_LABELS[ticket.status] ?? ticket.status}
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </>
        )}
      </div>

    </div>
  )
}
