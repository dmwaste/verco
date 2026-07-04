'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import type { Database } from '@/lib/supabase/types'
import { updateClient } from '../../actions'

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

  const inputClass = 'w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white'
  const labelClass = 'mb-1.5 block text-xs font-medium text-gray-500'

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl">
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500">Email & SMS</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Email From Name</label>
            <input type="text" {...register('email_from_name')} placeholder="e.g. City of Kwinana" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Reply-To Email</label>
            <input type="email" {...register('reply_to_email')} placeholder="e.g. waste@council.gov.au" className={inputClass} />
            {errors.reply_to_email && <p className="mt-1 text-2xs text-red-500">Must be a valid email</p>}
          </div>
          <div>
            <label className={labelClass}>SMS Sender ID</label>
            <input type="text" {...register('sms_sender_id')} maxLength={11} placeholder="e.g. Kwinana" className={inputClass} />
            <p className="mt-1 text-2xs text-gray-400">Max 11 chars, alphanumeric</p>
          </div>
          <div>
            <label className={labelClass}>SMS Reminder Days Before</label>
            <input type="number" {...register('sms_reminder_days_before', { valueAsNumber: true })} min={1} max={7} className={inputClass} />
          </div>
        </div>
        <div className="mt-4">
          <label className={labelClass}>Email Footer HTML</label>
          <textarea {...register('email_footer_html')} rows={4} className={`${inputClass} resize-none font-mono text-2xs`} placeholder="<p>City of Kwinana &middot; PO Box 21...</p>" />
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
