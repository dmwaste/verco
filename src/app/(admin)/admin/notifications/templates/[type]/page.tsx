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
const GITHUB_REPO = 'dmwaste/verco'
const GITHUB_BRANCH = 'develop'

function renderEmail(
  type: NotificationType,
  booking: BookingForDispatch,
): RenderedEmail {
  switch (type) {
    case 'booking_created':
      return renderBookingCreated(booking, APP_URL)
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
        photos: [],
        contractor_fault: false,
        serviceLabel: 'E-Waste, Mattress',
      })
    case 'np_raised':
      return renderNpRaised(booking, APP_URL, {
        notes: 'Verge was empty at 09:30. Crew checked both sides of driveway.',
        photos: [],
        contractor_fault: false,
        serviceLabel: 'Bulk Waste',
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
