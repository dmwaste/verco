import { notFound } from 'next/navigation'
import { promises as fs } from 'fs'
import path from 'path'
import { createClient } from '@/lib/supabase/server'
import type { BookingForDispatch } from '@/lib/notifications/dispatch'
import type {
  NotificationType,
  RenderedEmail,
  RenderedSMS,
} from '@/lib/notifications/templates/types'
import { renderBookingCreated, renderBookingCreatedSMS } from '@/lib/notifications/templates/booking-created'
import { renderBookingUpdated } from '@/lib/notifications/templates/booking-updated'
import { renderBookingCancelled } from '@/lib/notifications/templates/booking-cancelled'
import { renderCollectionReminder, renderCollectionReminderSMS } from '@/lib/notifications/templates/collection-reminder'
import { renderCompletionSurvey } from '@/lib/notifications/templates/completion-survey'
import { renderNcnRaised } from '@/lib/notifications/templates/ncn-raised'
import { renderNpRaised } from '@/lib/notifications/templates/np-raised'
import { renderPaymentExpired } from '@/lib/notifications/templates/payment-expired'
import { renderPaymentReminder } from '@/lib/notifications/templates/payment-reminder'
import { getCatalogEntry } from '../registry'
import {
  makePreviewBooking,
  PREVIEW_TENANT_LABELS,
  type PreviewTenant,
} from '../preview-fixtures'
import { TemplateDetail } from './template-detail'

const APP_URL = 'https://verco.au'
const TENANTS: PreviewTenant[] = ['vergevalet', 'kwn', 'unbranded']
// Illustrative crew photos for the NCN/NP previews (self-contained data URIs so
// the preview renders offline). Real notices carry public Supabase storage URLs.
const SAMPLE_PHOTOS = [
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NDAiIGhlaWdodD0iMzgwIj48cmVjdCB3aWR0aD0iNjQwIiBoZWlnaHQ9IjM4MCIgZmlsbD0iI2U3ZWNmMCIvPjxyZWN0IHg9IjAiIHk9IjMwMCIgd2lkdGg9IjY0MCIgaGVpZ2h0PSI4MCIgZmlsbD0iI2QzZGJlMSIvPjxjaXJjbGUgY3g9IjEyMCIgY3k9IjE1MCIgcj0iNDYiIGZpbGw9IiNjMmNjZDQiLz48cmVjdCB4PSIyMzAiIHk9IjEyMCIgd2lkdGg9IjMwMCIgaGVpZ2h0PSIxMjAiIHJ4PSI2IiBmaWxsPSIjY2JkNGRiIi8+PHRleHQgeD0iMzIwIiB5PSIzNTIiIGZvbnQtZmFtaWx5PSJBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjIyIiBmaWxsPSIjNmI3Yzg5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5DcmV3IHBob3RvIOKAlCB2ZXJnZSwgZnJvbnQ8L3RleHQ+PC9zdmc+',
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NDAiIGhlaWdodD0iMzgwIj48cmVjdCB3aWR0aD0iNjQwIiBoZWlnaHQ9IjM4MCIgZmlsbD0iI2VjZTdlMiIvPjxyZWN0IHg9IjYwIiB5PSI4MCIgd2lkdGg9IjI0MCIgaGVpZ2h0PSIyMjAiIHJ4PSI4IiBmaWxsPSIjZDhjZmM0Ii8+PHJlY3QgeD0iMzQwIiB5PSIxNTAiIHdpZHRoPSIyNDAiIGhlaWdodD0iMTUwIiByeD0iOCIgZmlsbD0iI2NjYzJiNCIvPjx0ZXh0IHg9IjMyMCIgeT0iMzUyIiBmb250LWZhbWlseT0iQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIyMiIgZmlsbD0iIzhhN2Q2YyIgdGV4dC1hbmNob3I9Im1pZGRsZSI+Q3JldyBwaG90byDigJQgaXRlbXMgYmVoaW5kIGZlbmNlPC90ZXh0Pjwvc3ZnPg==',
]
const GITHUB_REPO = 'dmwaste/verco'
const GITHUB_BRANCH = 'develop'

function renderEmail(
  type: NotificationType,
  booking: BookingForDispatch,
): RenderedEmail {
  switch (type) {
    case 'booking_created':
      return renderBookingCreated(booking, APP_URL)
    case 'booking_updated':
      return renderBookingUpdated(booking, APP_URL, {
        refundCents: 5000,
        refundStatus: 'processed',
      })
    case 'booking_cancelled':
      return renderBookingCancelled(booking, APP_URL, {
        reason: 'Contractor unavailable',
        refund_status: 'processed',
      })
    case 'collection_reminder':
      return renderCollectionReminder(booking, APP_URL)
    case 'payment_reminder':
      return renderPaymentReminder(booking, APP_URL)
    case 'payment_expired':
      return renderPaymentExpired(booking, APP_URL)
    case 'ncn_raised':
      return renderNcnRaised(booking, APP_URL, {
        reason: 'Building Waste',
        notes: 'Cement and bricks behind the fence.',
        photos: SAMPLE_PHOTOS,
        contractor_fault: false,
        serviceLabel: 'E-Waste, Mattress',
        pendingServices: 'Green Waste',
      })
    case 'np_raised':
      return renderNpRaised(booking, APP_URL, {
        notes: 'Verge was empty at 09:30. Crew checked both sides of driveway.',
        photos: SAMPLE_PHOTOS,
        contractor_fault: false,
        serviceLabel: 'Bulk Waste',
        pendingServices: 'Green Waste',
      })
    case 'completion_survey':
      return renderCompletionSurvey(booking, APP_URL, 'sample-survey-token')
  }
}

function renderSms(
  type: NotificationType,
  booking: BookingForDispatch,
): RenderedSMS | null {
  switch (type) {
    case 'booking_created':
      return renderBookingCreatedSMS(booking)
    case 'collection_reminder':
      return renderCollectionReminderSMS(booking)
    case 'booking_updated':
    case 'booking_cancelled':
    case 'payment_reminder':
    case 'payment_expired':
    case 'ncn_raised':
    case 'np_raised':
    case 'completion_survey':
      return null
  }
}

export interface RenderedForTenant {
  tenant: PreviewTenant
  label: string
  email: RenderedEmail
  sms: RenderedSMS | null
  booking: BookingForDispatch
}

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ type: string }>
}) {
  const { type } = await params

  // Contractor-internal gating — same pattern as the list page.
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'contractor-admin') {
    notFound()
  }

  const entry = getCatalogEntry(type)
  if (!entry) {
    notFound()
  }

  // Render against all 3 tenants server-side. The client component swaps
  // which HTML string the iframe shows; never re-renders templates in browser.
  const rendered: RenderedForTenant[] = TENANTS.map((tenant) => {
    const booking = makePreviewBooking(tenant)
    return {
      tenant,
      label: PREVIEW_TENANT_LABELS[tenant],
      email: renderEmail(entry.type, booking),
      sms: renderSms(entry.type, booking),
      booking,
    }
  })

  // Read source from disk at request time. cwd is the Next.js project root.
  let source: string
  try {
    source = await fs.readFile(path.join(process.cwd(), entry.sourceFile), 'utf8')
  } catch (err) {
    source = `// Failed to read source file at ${entry.sourceFile}\n// ${err instanceof Error ? err.message : String(err)}`
  }

  const denoMirror = entry.sourceFile.replace(
    'src/lib/notifications/templates/',
    'supabase/functions/_shared/templates/',
  )

  return (
    <TemplateDetail
      entry={entry}
      rendered={rendered}
      source={source}
      denoMirror={denoMirror}
      githubViewUrl={`https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${entry.sourceFile}`}
      githubEditUrl={`https://github.com/${GITHUB_REPO}/edit/${GITHUB_BRANCH}/${entry.sourceFile}`}
      githubDenoMirrorUrl={`https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${denoMirror}`}
    />
  )
}
