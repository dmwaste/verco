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
  name: z.string().min(1, 'Name is required'),
  slug: z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase alphanumeric with hyphens'),
  service_name: z.string().nullable(),
  custom_domain: z.string().nullable(),
  is_active: z.boolean(),
  contact_name: z.string().nullable(),
  contact_phone: z.string().nullable(),
  contact_email: z.string().nullable(),
  privacy_policy_url: z.string().nullable(),
  landing_headline: z.string().nullable(),
  landing_subheading: z.string().nullable(),
})

type FormValues = z.infer<typeof schema>

export function GeneralTab({ client }: { client: Client }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: client.name,
      slug: client.slug,
      service_name: client.service_name ?? '',
      custom_domain: client.custom_domain ?? '',
      is_active: client.is_active,
      contact_name: client.contact_name ?? '',
      contact_phone: client.contact_phone ?? '',
      contact_email: client.contact_email ?? '',
      privacy_policy_url: client.privacy_policy_url ?? '',
      landing_headline: client.landing_headline ?? '',
      landing_subheading: client.landing_subheading ?? '',
    },
  })

  const { register, handleSubmit, formState: { errors, isSubmitting, isDirty } } = form

  async function onSubmit(values: FormValues) {
    setError(null)
    setSaved(false)
    const result = await updateClient(client.id, {
      ...values,
      service_name: values.service_name || null,
      custom_domain: values.custom_domain || null,
      contact_name: values.contact_name || null,
      contact_phone: values.contact_phone || null,
      contact_email: values.contact_email || null,
      privacy_policy_url: values.privacy_policy_url || null,
      landing_headline: values.landing_headline || null,
      landing_subheading: values.landing_subheading || null,
    })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSaved(true)
    router.refresh()
  }

  const sectionHeader = 'mb-3 text-caption font-semibold uppercase tracking-wide text-gray-500'

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl">
      {/* Identity */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className={sectionHeader}>Identity</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor="name">Client Name *</FieldLabel>
            <Input id="name" type="text" {...register('name')} />
            {errors.name && <p className="mt-1 text-2xs text-red-500">{errors.name.message}</p>}
          </div>
          <div>
            <FieldLabel htmlFor="slug">Slug *</FieldLabel>
            <Input id="slug" type="text" mono {...register('slug')} />
            {errors.slug && <p className="mt-1 text-2xs text-red-500">{errors.slug.message}</p>}
          </div>
          <div>
            <FieldLabel htmlFor="service_name">Service Name</FieldLabel>
            <Input id="service_name" type="text" {...register('service_name')} placeholder="e.g. Verge Collection" />
          </div>
          <div>
            <FieldLabel htmlFor="custom_domain">Custom Domain</FieldLabel>
            <Input id="custom_domain" type="text" {...register('custom_domain')} placeholder="e.g. bookings.council.gov.au" />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input type="checkbox" {...register('is_active')} id="is_active" className="size-4 rounded border-gray-300" />
          <label htmlFor="is_active" className="text-body-sm text-gray-700">Active</label>
        </div>
      </div>

      {/* Contact */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className={sectionHeader}>Contact Information</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor="contact_name">Contact Name</FieldLabel>
            <Input id="contact_name" type="text" {...register('contact_name')} />
          </div>
          <div>
            <FieldLabel htmlFor="contact_phone">Contact Phone</FieldLabel>
            <Input id="contact_phone" type="text" {...register('contact_phone')} />
          </div>
          <div>
            <FieldLabel htmlFor="contact_email">Contact Email</FieldLabel>
            <Input id="contact_email" type="email" {...register('contact_email')} />
          </div>
          <div>
            <FieldLabel htmlFor="privacy_policy_url">Privacy Policy URL</FieldLabel>
            <Input id="privacy_policy_url" type="url" {...register('privacy_policy_url')} />
          </div>
        </div>
      </div>

      {/* Landing Page */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className={sectionHeader}>Landing Page Copy</div>
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel htmlFor="landing_headline">Headline</FieldLabel>
            <Input id="landing_headline" type="text" {...register('landing_headline')} />
          </div>
          <div>
            <FieldLabel htmlFor="landing_subheading">Subheading</FieldLabel>
            <Textarea id="landing_subheading" {...register('landing_subheading')} rows={3} className="resize-none" />
          </div>
        </div>
      </div>

      {/* Actions */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">{error}</div>
      )}
      {saved && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-body-sm text-emerald-700">Changes saved.</div>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isSubmitting || !isDirty}
          className="rounded-lg bg-[#293F52] px-5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50"
        >
          {isSubmitting ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          type="button"
          onClick={() => form.reset()}
          disabled={!isDirty}
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-5 py-2.5 text-body-sm font-semibold text-gray-700 disabled:opacity-40"
        >
          Discard
        </button>
      </div>
    </form>
  )
}
