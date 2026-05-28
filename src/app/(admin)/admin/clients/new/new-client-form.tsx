'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import Link from 'next/link'
import { createNewClient } from '../actions'

const schema = z.object({
  name: z.string().min(1, 'Client name is required'),
  slug: z.string().min(1, 'Slug is required').regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase alphanumeric with hyphens only'),
  primary_colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent_colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})

type FormValues = z.infer<typeof schema>

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export function NewClientForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      slug: '',
      primary_colour: '#293F52',
      accent_colour: '#00E47C',
    },
  })

  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = form

  async function onSubmit(values: FormValues) {
    setError(null)
    const result = await createNewClient(values)
    if (!result.ok) {
      setError(result.error)
      return
    }
    router.push(`/admin/clients/${result.data.id}`)
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg rounded-xl bg-white p-6 shadow-sm">
      <div className="mb-5">
        <label className="mb-1.5 block text-body-sm font-medium text-gray-700">
          Client Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          {...register('name', {
            onChange: (e) => {
              // eslint-disable-next-line react-hooks/incompatible-library -- react-hook-form's watch() returns subscription-backed values that the React Compiler can't statically analyze; reading it inside an event handler is correct
              const current = watch('slug')
              const autoSlug = slugify(e.target.value)
              // Only auto-update slug if it matches what auto-generation would produce
              // (i.e. user hasn't manually edited it)
              if (!current || current === slugify(watch('name'))) {
                setValue('slug', autoSlug)
              }
            },
          })}
          placeholder="e.g. City of Kwinana"
          className="w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white"
        />
        {errors.name && <p className="mt-1 text-2xs text-red-500">{errors.name.message}</p>}
      </div>

      <div className="mb-5">
        <label className="mb-1.5 block text-body-sm font-medium text-gray-700">
          Slug <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          {...register('slug')}
          placeholder="e.g. kwn"
          className="w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 font-mono text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white"
        />
        <p className="mt-1 text-2xs text-gray-400">Used in the URL: <span className="font-mono">{watch('slug') || 'slug'}.verco.app</span></p>
        {errors.slug && <p className="mt-1 text-2xs text-red-500">{errors.slug.message}</p>}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1.5 block text-body-sm font-medium text-gray-700">Primary Colour</label>
          <div className="flex items-center gap-2">
            <div
              className="size-8 shrink-0 rounded-md border border-gray-200"
              style={{ backgroundColor: watch('primary_colour') }}
            />
            <input
              type="text"
              {...register('primary_colour')}
              className="w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 font-mono text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white"
            />
          </div>
          {errors.primary_colour && <p className="mt-1 text-2xs text-red-500">Must be a valid hex colour</p>}
        </div>
        <div>
          <label className="mb-1.5 block text-body-sm font-medium text-gray-700">Accent Colour</label>
          <div className="flex items-center gap-2">
            <div
              className="size-8 shrink-0 rounded-md border border-gray-200"
              style={{ backgroundColor: watch('accent_colour') }}
            />
            <input
              type="text"
              {...register('accent_colour')}
              className="w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 font-mono text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white"
            />
          </div>
          {errors.accent_colour && <p className="mt-1 text-2xs text-red-500">Must be a valid hex colour</p>}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-lg bg-[#293F52] px-5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50"
        >
          {isSubmitting ? 'Creating...' : 'Create Client'}
        </button>
        <Link
          href="/admin/clients"
          className="rounded-lg border-[1.5px] border-gray-100 bg-white px-5 py-2.5 text-body-sm font-semibold text-gray-700"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
