'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { Database } from '@/lib/supabase/types'
import { updateClient } from '../../actions'
import { FieldLabel, Input, Textarea } from '@/components/admin/form'

type Client = Database['public']['Tables']['client']['Row']

const schema = z.object({
  email_from_name: z.string().nullable(),
  reply_to_email: z.string().nullable(),
  sms_sender_id: z.string().max(11).nullable(),
  sms_reminder_days_before: z.number().int().min(1).max(7).nullable(),
  email_footer_html: z.string().nullable(),
})

type FormValues = z.infer<typeof schema>

export function NotificationsTab({ client }: { client: Client }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      email_from_name: client.email_from_name ?? '',
      reply_to_email: client.reply_to_email ?? '',
      sms_sender_id: client.sms_sender_id ?? '',
      sms_reminder_days_before: client.sms_reminder_days_before ?? 2,
      email_footer_html: client.email_footer_html ?? '',
    },
  })

  const { register, handleSubmit, formState: { errors, isSubmitting, isDirty } } = form

  async function onSubmit(values: FormValues) {
    setError(null)
    setSaved(false)
    const result = await updateClient(client.id, {
      email_from_name: values.email_from_name || null,
      reply_to_email: values.reply_to_email || null,
      sms_sender_id: values.sms_sender_id || null,
      sms_reminder_days_before: values.sms_reminder_days_before,
      email_footer_html: values.email_footer_html || null,
    })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSaved(true)
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl">
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">Email & SMS</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor="email_from_name">Email From Name</FieldLabel>
            <Input id="email_from_name" type="text" {...register('email_from_name')} placeholder="e.g. City of Kwinana" />
          </div>
          <div>
            <FieldLabel htmlFor="reply_to_email">Reply-To Email</FieldLabel>
            <Input id="reply_to_email" type="email" {...register('reply_to_email')} placeholder="e.g. waste@council.gov.au" />
            {errors.reply_to_email && <p className="mt-1 text-2xs text-red-500">Must be a valid email</p>}
          </div>
          <div>
            <FieldLabel htmlFor="sms_sender_id">SMS Sender ID</FieldLabel>
            <Input id="sms_sender_id" type="text" {...register('sms_sender_id')} maxLength={11} placeholder="e.g. Kwinana" />
            <p className="mt-1 text-2xs text-gray-400">Max 11 chars, alphanumeric</p>
          </div>
          <div>
            <FieldLabel htmlFor="sms_reminder_days_before">SMS Reminder Days Before</FieldLabel>
            <Input id="sms_reminder_days_before" type="number" {...register('sms_reminder_days_before', { valueAsNumber: true })} min={1} max={7} />
          </div>
        </div>
        <div className="mt-4">
          <FieldLabel htmlFor="email_footer_html">Email Footer HTML</FieldLabel>
          <Textarea id="email_footer_html" mono {...register('email_footer_html')} rows={4} className="resize-none text-2xs" placeholder="<p>City of Kwinana &middot; PO Box 21...</p>" />
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">{error}</div>}
      {saved && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-body-sm text-emerald-700">Changes saved.</div>}
      <div className="flex gap-3">
        <button type="submit" disabled={isSubmitting || !isDirty} className="rounded-lg bg-[#293F52] px-5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50">
          {isSubmitting ? 'Saving...' : 'Save Changes'}
        </button>
        <button type="button" onClick={() => form.reset()} disabled={!isDirty} className="rounded-lg border-[1.5px] border-gray-100 bg-white px-5 py-2.5 text-body-sm font-semibold text-gray-700 disabled:opacity-40">
          Discard
        </button>
      </div>
    </form>
  )
}
