'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Database } from '@/lib/supabase/types'
import { FaqAnswer } from '@/components/faq-answer'
import type { FaqItem } from '@/lib/client/branding-defaults'
import { updateClientFaqs } from '../../actions'
import { Input, Textarea } from '@/components/admin/form'

type Client = Database['public']['Tables']['client']['Row']

export function FaqsTab({ client }: { client: Client }) {
  const router = useRouter()
  const [items, setItems] = useState<FaqItem[]>(
    (client.faq_items as FaqItem[] | null) ?? []
  )
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editQuestion, setEditQuestion] = useState('')
  const [editAnswer, setEditAnswer] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  function startEdit(index: number) {
    setEditingIndex(index)
    setEditQuestion(items[index].question)
    setEditAnswer(items[index].answer)
  }

  function cancelEdit() {
    setEditingIndex(null)
    setEditQuestion('')
    setEditAnswer('')
  }

  function saveEdit() {
    if (editingIndex === null) return
    if (!editQuestion.trim() || !editAnswer.trim()) return

    const updated = [...items]
    updated[editingIndex] = { question: editQuestion.trim(), answer: editAnswer.trim() }
    setItems(updated)
    cancelEdit()
  }

  function addNew() {
    setItems([...items, { question: '', answer: '' }])
    setEditingIndex(items.length)
    setEditQuestion('')
    setEditAnswer('')
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index))
    if (editingIndex === index) cancelEdit()
  }

  function moveUp(index: number) {
    if (index === 0) return
    const updated = [...items]
    ;[updated[index - 1], updated[index]] = [updated[index], updated[index - 1]]
    setItems(updated)
  }

  function moveDown(index: number) {
    if (index >= items.length - 1) return
    const updated = [...items]
    ;[updated[index], updated[index + 1]] = [updated[index + 1], updated[index]]
    setItems(updated)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    const result = await updateClientFaqs(client.id, items)
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
      <div className="mb-2 text-2xs text-gray-400">Displayed on the public contact page. Markdown supported &mdash; lists, tables, links, bold. Reorder with arrows.</div>

      <div className="flex flex-col gap-2">
        {items.map((item, index) => (
          <div key={index} className="rounded-xl border-[1.5px] border-gray-100 bg-white shadow-sm">
            {editingIndex === index ? (
              <div className="p-4">
                <Input
                  type="text"
                  aria-label="FAQ question"
                  value={editQuestion}
                  onChange={(e) => setEditQuestion(e.target.value)}
                  placeholder="Question"
                  className="mb-2"
                />
                <Textarea
                  mono
                  aria-label="FAQ answer"
                  value={editAnswer}
                  onChange={(e) => setEditAnswer(e.target.value)}
                  placeholder="Answer (markdown supported)"
                  rows={8}
                  className="mb-3 resize-y"
                />
                {editAnswer.trim() && (
                  <div className="mb-3 rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5">
                    <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-gray-400">Preview</div>
                    <div className="text-body-sm leading-relaxed text-gray-600">
                      <FaqAnswer markdown={editAnswer} />
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <button type="button" onClick={saveEdit} className="rounded-lg bg-[#293F52] px-3 py-1.5 text-2xs font-semibold text-white">Done</button>
                  <button type="button" onClick={cancelEdit} className="rounded-lg border border-gray-200 px-3 py-1.5 text-2xs font-semibold text-gray-600">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 p-4">
                <div className="flex flex-col gap-1 pt-0.5">
                  <button type="button" onClick={() => moveUp(index)} disabled={index === 0} className="text-gray-300 hover:text-gray-500 disabled:opacity-30">&#9650;</button>
                  <button type="button" onClick={() => moveDown(index)} disabled={index >= items.length - 1} className="text-gray-300 hover:text-gray-500 disabled:opacity-30">&#9660;</button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-body-sm font-semibold text-[#293F52]">{item.question || '(empty)'}</div>
                  <div className="mt-0.5 text-2xs text-gray-500 line-clamp-2">{item.answer || '(empty)'}</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => startEdit(index)} className="text-2xs text-gray-500 hover:text-[#293F52]">Edit</button>
                  <button type="button" onClick={() => removeItem(index)} className="text-2xs text-red-500 hover:text-red-700">Remove</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addNew}
        className="mt-3 w-full rounded-xl border-[1.5px] border-dashed border-gray-200 py-3 text-center text-body-sm text-gray-400 hover:border-gray-300 hover:text-gray-600"
      >
        + Add FAQ
      </button>

      {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">{error}</div>}
      {saved && <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-body-sm text-emerald-700">Changes saved.</div>}
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
