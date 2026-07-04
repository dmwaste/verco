'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Database } from '@/lib/supabase/types'
import { FaqAnswer } from '@/components/faq-answer'
import { clientHasTerms } from '@/lib/booking/terms'
import { updateClientTerms } from '../../actions'
import { Textarea } from '@/components/admin/form'

type Client = Database['public']['Tables']['client']['Row']

export function TermsTab({ client }: { client: Client }) {
  const router = useRouter()
  const [markdown, setMarkdown] = useState(client.terms_markdown ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const hasTerms = clientHasTerms(markdown)

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    const result = await updateClientTerms(client.id, markdown)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSaved(true)
    router.refresh()
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-2 text-2xs text-gray-400">
        Shown to residents (and to staff on-behalf) before a booking is confirmed. Markdown
        supported &mdash; lists, tables, links, bold. The terms entered here are the
        council&rsquo;s; Verco captures acceptance only.
      </div>

      {!hasTerms && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-body-sm text-amber-800">
          No Terms &amp; Conditions configured &mdash; residents will book <strong>without</strong> a
          consent step. Add terms below to switch the acceptance gate on for this client.
        </div>
      )}

      <Textarea
        mono
        aria-label="Terms &amp; Conditions markdown"
        value={markdown}
        onChange={(e) => setMarkdown(e.target.value)}
        placeholder="Enter the council's Terms &amp; Conditions (markdown supported)"
        rows={14}
        className="resize-y"
      />

      {hasTerms && (
        <div className="mt-3 rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5">
          <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-gray-400">
            Preview
          </div>
          <div className="text-body-sm leading-relaxed text-gray-600">
            <FaqAnswer markdown={markdown} />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-body-sm text-emerald-700">
          Changes saved.
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="mt-4 rounded-lg bg-[#293F52] px-5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  )
}
