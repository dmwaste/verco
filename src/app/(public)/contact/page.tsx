import { Suspense } from 'react'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { ContactPageClient } from './contact-page-client'
import { FaqAccordion } from '@/components/contact/faq-accordion'
import { FaqAnswer } from '@/components/faq-answer'
import { DEFAULT_FAQS, type FaqItem } from '@/lib/client/branding-defaults'

export default async function ContactPage() {
  const headersList = await headers()
  const clientId = headersList.get('x-client-id') ?? ''

  const supabase = await createClient()

  const { data: client } = await supabase
    .from('client')
    .select('id, service_name, contact_name, contact_phone, contact_email, faq_items')
    .eq('id', clientId)
    .single()

  const serviceName = client?.service_name ?? 'Verge Collection'
  const contactName = client?.contact_name ?? 'D&M Waste Management'
  const contactPhone = client?.contact_phone ?? '08 9527 5500'
  const contactEmail = client?.contact_email ?? 'info@dmwastemanagement.com.au'

  // Resolve FAQs — use client's faq_items if valid, otherwise fall back to defaults
  const rawFaqs = client?.faq_items
  let faqItems = DEFAULT_FAQS
  if (Array.isArray(rawFaqs) && rawFaqs.length > 0) {
    const valid = rawFaqs.every(
      (item): item is FaqItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).question === 'string' &&
        typeof (item as Record<string, unknown>).answer === 'string'
    )
    if (valid) {
      faqItems = rawFaqs as FaqItem[]
    }
  }

  // Render markdown answers here (server side) so react-markdown stays out of
  // the public client bundle — the accordion only receives finished nodes.
  const faqs = faqItems.map((faq) => ({
    question: faq.question,
    answer: <FaqAnswer markdown={faq.answer} />,
  }))

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[var(--brand)] md:text-3xl">
          Contact Us
        </h1>
        <p className="mt-1 text-sm text-gray-500 md:text-base">
          {serviceName}
        </p>
      </div>

      {/* Contact details card */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 text-2xs font-semibold uppercase tracking-wide text-gray-500">
          Contact Details
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#EBF5FF]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#3182CE"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <div>
              <div className="text-xs text-gray-500">Managed by</div>
              <div className="text-sm font-medium text-[var(--brand)]">
                {contactName}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-accent-light)]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--brand-accent-dark)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
            </div>
            <div>
              <div className="text-xs text-gray-500">Phone</div>
              <a
                href={`tel:${contactPhone.replace(/\s/g, '')}`}
                className="text-sm font-medium text-[var(--brand-accent-dark)] hover:underline"
              >
                {contactPhone}
              </a>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#F3EEFF]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#805AD5"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            </div>
            <div>
              <div className="text-xs text-gray-500">Email</div>
              <a
                href={`mailto:${contactEmail}`}
                className="text-sm font-medium text-[#805AD5] hover:underline"
              >
                {contactEmail}
              </a>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#FFF3EA]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#FF8C42"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div>
              <div className="text-xs text-gray-500">Hours</div>
              <div className="text-sm font-medium text-[var(--brand)]">
                Mon&ndash;Fri 8am&ndash;5pm AWST
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* FAQ accordion */}
      <div id="faqs" className="mb-6">
        <h2 className="mb-4 font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)] md:text-xl">
          Frequently Asked Questions
        </h2>
        <FaqAccordion faqs={faqs} />
      </div>

      {/* Bridging heading */}
      <h2 className="mb-4 font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)] md:text-xl">
        Still have a question?
      </h2>

      {/* Service ticket form — wrapped in Suspense for useSearchParams */}
      <Suspense
        fallback={
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <div className="flex items-center justify-center py-8">
              <div className="size-6 animate-spin rounded-full border-2 border-gray-200 border-t-[var(--brand)]" />
            </div>
          </div>
        }
      >
        <ContactPageClient clientId={clientId} />
      </Suspense>
    </main>
  )
}
