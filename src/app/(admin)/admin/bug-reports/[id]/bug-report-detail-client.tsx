'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { VercoButton } from '@/components/ui/verco-button'
import { addBugReportComment, updateBugReport } from '../actions'

interface BugDetail {
  id: string
  display_id: string
  title: string
  description: string | null
  source_app: string
  category: string | null
  priority: string
  status: string
  page_url: string | null
  browser_info: string | null
  linear_issue_id: string | null
  linear_issue_url: string | null
  github_issue_number: number | null
  github_issue_url: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  resolution_notes: string | null
  reporter: { display_name: string | null } | null
  assigned: { display_name: string | null } | null
  client: { name: string | null; slug: string | null } | null
}

interface Comment {
  id: string
  comment: string
  is_internal: boolean
  created_at: string
  author: { display_name: string | null } | null
}

const STATUS_OPTIONS = ['new', 'triaged', 'in_progress', 'resolved', 'closed', 'wont_fix'] as const
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'] as const

interface Props {
  bug: BugDetail
  comments: Comment[]
}

export function BugReportDetailClient({ bug, comments }: Props) {
  const router = useRouter()
  const [commentText, setCommentText] = useState('')
  const [isInternal, setIsInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleStatusChange(status: string) {
    setBusy(true); setError(null)
    const result = await updateBugReport({ id: bug.id, status: status as (typeof STATUS_OPTIONS)[number] })
    setBusy(false)
    if (!result.ok) setError(result.error)
    else router.refresh()
  }

  async function handlePriorityChange(priority: string) {
    setBusy(true); setError(null)
    const result = await updateBugReport({ id: bug.id, priority: priority as (typeof PRIORITY_OPTIONS)[number] })
    setBusy(false)
    if (!result.ok) setError(result.error)
    else router.refresh()
  }

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault()
    if (!commentText.trim()) return
    setBusy(true); setError(null)
    const result = await addBugReportComment({
      bug_report_id: bug.id,
      comment: commentText.trim(),
      is_internal: isInternal,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
    } else {
      setCommentText('')
      setIsInternal(false)
      router.refresh()
    }
  }

  return (
    <div className="grid flex-1 grid-cols-1 gap-6 px-7 py-6 tablet:grid-cols-3">
      {/* Main column */}
      <div className="space-y-6 tablet:col-span-2">
        <section className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="text-body-sm font-semibold uppercase tracking-wide text-gray-500">
            Description
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-body text-gray-900">
            {bug.description ?? <span className="text-gray-400 italic">No description provided</span>}
          </p>
        </section>

        <section className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="text-body-sm font-semibold uppercase tracking-wide text-gray-500">
            Comments ({comments.length})
          </h2>
          <ul className="mt-3 space-y-3">
            {comments.length === 0 && (
              <li className="text-body-sm text-gray-400 italic">No comments yet.</li>
            )}
            {comments.map((c) => (
              <li key={c.id} className="rounded-lg bg-gray-50 p-3">
                <div className="flex items-center justify-between text-body-sm">
                  <span className="font-medium text-gray-800">
                    {c.author?.display_name ?? 'Unknown'}
                    {c.is_internal && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold uppercase text-amber-800">
                        internal
                      </span>
                    )}
                  </span>
                  <span className="text-gray-500">
                    {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-body text-gray-700">{c.comment}</p>
              </li>
            ))}
          </ul>

          <form onSubmit={handleAddComment} className="mt-4 space-y-2">
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              rows={3}
              placeholder="Add a comment…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-body focus:border-[#293F52] focus:outline-none focus:ring-1 focus:ring-[#293F52]"
              disabled={busy}
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-body-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={isInternal}
                  onChange={(e) => setIsInternal(e.target.checked)}
                  className="rounded"
                />
                Internal (not for reporter)
              </label>
              <VercoButton type="submit" variant="primary" disabled={busy || !commentText.trim()}>
                {busy ? 'Sending…' : 'Comment'}
              </VercoButton>
            </div>
            {error && <p role="alert" className="text-body-sm text-red-600">{error}</p>}
          </form>
        </section>
      </div>

      {/* Side panel */}
      <aside className="space-y-4">
        <section className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="text-body-sm font-semibold uppercase tracking-wide text-gray-500">
            Status
          </h2>
          <select
            value={bug.status}
            onChange={(e) => handleStatusChange(e.target.value)}
            disabled={busy}
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-body"
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>

          <h2 className="mt-4 text-body-sm font-semibold uppercase tracking-wide text-gray-500">
            Priority
          </h2>
          <select
            value={bug.priority}
            onChange={(e) => handlePriorityChange(e.target.value)}
            disabled={busy}
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-body"
          >
            {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </section>

        <section className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="text-body-sm font-semibold uppercase tracking-wide text-gray-500">
            Context
          </h2>
          <dl className="mt-2 space-y-2 text-body-sm">
            <div>
              <dt className="text-gray-500">Reporter</dt>
              <dd className="text-gray-900">{bug.reporter?.display_name ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Assigned</dt>
              <dd className="text-gray-900">{bug.assigned?.display_name ?? 'Unassigned'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Tenant</dt>
              <dd className="text-gray-900">{bug.client?.name ?? bug.client?.slug ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Category</dt>
              <dd className="text-gray-900">{bug.category ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Source app</dt>
              <dd className="text-gray-900">{bug.source_app}</dd>
            </div>
            {bug.page_url && (
              <div>
                <dt className="text-gray-500">Page</dt>
                <dd className="break-all text-gray-900">
                  <a href={bug.page_url} target="_blank" rel="noreferrer" className="text-[#293F52] underline">
                    {bug.page_url}
                  </a>
                </dd>
              </div>
            )}
            {bug.github_issue_url ? (
              <div>
                <dt className="text-gray-500">GitHub</dt>
                <dd>
                  <a href={bug.github_issue_url} target="_blank" rel="noreferrer" className="text-[#293F52] underline">
                    {bug.github_issue_number ? `#${bug.github_issue_number}` : 'View issue'}
                  </a>
                </dd>
              </div>
            ) : bug.linear_issue_url ? (
              <div>
                <dt className="text-gray-500">Linear</dt>
                <dd>
                  <a href={bug.linear_issue_url} target="_blank" rel="noreferrer" className="text-[#293F52] underline">
                    {bug.linear_issue_id ?? 'View in Linear'}
                  </a>
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-gray-500">Created</dt>
              <dd className="text-gray-900">
                {formatDistanceToNow(new Date(bug.created_at), { addSuffix: true })}
              </dd>
            </div>
          </dl>
        </section>

        {bug.browser_info && (
          <section className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-body-sm font-semibold uppercase tracking-wide text-gray-500">
              Browser
            </h2>
            <p className="mt-2 break-all text-2xs text-gray-600">{bug.browser_info}</p>
          </section>
        )}
      </aside>
    </div>
  )
}
