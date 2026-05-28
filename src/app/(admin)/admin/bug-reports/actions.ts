'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getCurrentAdminClient } from '@/lib/admin/current-client'
import type { Database } from '@/lib/supabase/types'
import type { Result } from '@/lib/result'

type BugCategory = Database['public']['Enums']['bug_report_category']
type BugPriority = Database['public']['Enums']['bug_report_priority']
type BugStatus = Database['public']['Enums']['bug_report_status']

const CATEGORIES: readonly [BugCategory, ...BugCategory[]] = [
  'ui', 'data', 'performance', 'access',
  'booking', 'collection', 'billing', 'other',
]

const PRIORITIES: readonly [BugPriority, ...BugPriority[]] = [
  'low', 'medium', 'high', 'critical',
]

const STATUSES: readonly [BugStatus, ...BugStatus[]] = [
  'new', 'triaged', 'in_progress', 'resolved', 'closed', 'wont_fix',
]

const CreateBugReportInput = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters').max(150),
  description: z.string().max(4000).optional().or(z.literal('')).transform((v) => v || undefined),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES).default('medium'),
  page_url: z.string().max(2000).optional(),
  browser_info: z.string().max(2000).optional(),
})

export type CreateBugReportInput = z.infer<typeof CreateBugReportInput>

export async function createBugReport(
  input: CreateBugReportInput
): Promise<Result<{ id: string; display_id: string }>> {
  const parsed = CreateBugReportInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  const supabase = await createClient()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    return { ok: false, error: 'Not authenticated' }
  }

  const currentClient = await getCurrentAdminClient()
  const clientId = currentClient?.id ?? null

  const { data, error } = await supabase
    .from('bug_report')
    .insert({
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      category: parsed.data.category,
      priority: parsed.data.priority,
      source_app: 'verco',
      reporter_id: userData.user.id,
      client_id: clientId,
      page_url: parsed.data.page_url ?? null,
      browser_info: parsed.data.browser_info ?? null,
    })
    .select('id, display_id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!data) {
    return { ok: false, error: 'Insert was not applied (RLS or missing role)' }
  }
  return { ok: true, data: { id: data.id, display_id: data.display_id } }
}

const UpdateBugReportInput = z.object({
  id: z.string().uuid(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  resolution_notes: z.string().max(4000).nullable().optional(),
})

export type UpdateBugReportInput = z.infer<typeof UpdateBugReportInput>

export async function updateBugReport(input: UpdateBugReportInput): Promise<Result<void>> {
  const parsed = UpdateBugReportInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  const supabase = await createClient()

  const patch: Record<string, unknown> = {}
  if (parsed.data.status !== undefined) patch.status = parsed.data.status
  if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority
  if (parsed.data.assigned_to !== undefined) patch.assigned_to = parsed.data.assigned_to
  if (parsed.data.resolution_notes !== undefined) patch.resolution_notes = parsed.data.resolution_notes

  if (parsed.data.status === 'resolved' || parsed.data.status === 'closed') {
    patch.resolved_at = new Date().toISOString()
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'No changes to apply' }
  }

  const { data, error } = await supabase
    .from('bug_report')
    .update(patch)
    .eq('id', parsed.data.id)
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!data) {
    return { ok: false, error: 'Update was not applied (no matching row or insufficient permissions)' }
  }
  return { ok: true, data: undefined }
}

const AddCommentInput = z.object({
  bug_report_id: z.string().uuid(),
  comment: z.string().min(1).max(4000),
  is_internal: z.boolean().default(false),
})

export type AddCommentInput = z.infer<typeof AddCommentInput>

export async function addBugReportComment(
  input: AddCommentInput
): Promise<Result<{ id: string }>> {
  const parsed = AddCommentInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  const supabase = await createClient()
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    return { ok: false, error: 'Not authenticated' }
  }

  const { data, error } = await supabase
    .from('bug_report_comment')
    .insert({
      bug_report_id: parsed.data.bug_report_id,
      author_id: userData.user.id,
      comment: parsed.data.comment,
      is_internal: parsed.data.is_internal,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  if (!data) {
    return { ok: false, error: 'Comment was not added (no matching bug or insufficient permissions)' }
  }
  return { ok: true, data: { id: data.id } }
}
