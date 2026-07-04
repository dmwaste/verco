import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DetailHeader } from '@/components/admin/detail-header'
import { BugReportDetailClient } from './bug-report-detail-client'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BugReportDetailPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()

  const [bugResult, commentsResult] = await Promise.all([
    supabase
      .from('bug_report')
      .select(
        `id, display_id, title, description, source_app, category, priority, status,
         page_url, browser_info, linear_issue_id, linear_issue_url,
         created_at, updated_at, resolved_at, resolution_notes,
         reporter_id, assigned_to,
         reporter:profiles!bug_report_reporter_id_fkey(display_name),
         assigned:profiles!bug_report_assigned_to_fkey(display_name),
         client:client_id(name, slug)`
      )
      .eq('id', id)
      .single(),
    supabase
      .from('bug_report_comment')
      .select('id, author_id, comment, is_internal, created_at')
      .eq('bug_report_id', id)
      .order('created_at', { ascending: true }),
  ])

  if (bugResult.error || !bugResult.data) {
    notFound()
  }

  const bug = bugResult.data
  const rawComments = commentsResult.data ?? []

  // Fetch comment authors separately + join in JS (avoid embedded-select
  // fragility on bug_report_comment.author_id → auth.users → profiles).
  const authorIds = Array.from(new Set(rawComments.map((c) => c.author_id)))
  let authorByUserId = new Map<string, { display_name: string | null }>()
  if (authorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', authorIds)
    authorByUserId = new Map((profiles ?? []).map((p) => [p.id, { display_name: p.display_name }]))
  }
  const comments = rawComments.map((c) => ({
    id: c.id,
    comment: c.comment,
    is_internal: c.is_internal,
    created_at: c.created_at,
    author: authorByUserId.get(c.author_id) ?? null,
  }))

  return (
    <div className="flex flex-1 flex-col">
      <DetailHeader
        backHref="/admin/bug-reports"
        backLabel="Bug reports"
        title={`${bug.display_id} — ${bug.title}`}
      />

      <BugReportDetailClient bug={bug} comments={comments} />
    </div>
  )
}
