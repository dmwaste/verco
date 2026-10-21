import type { createClient } from '@/lib/supabase/server'
import { PROPERTY_DOCUMENTS_BUCKET } from './validation'

type ServerSupabase = Awaited<ReturnType<typeof createClient>>

/** A property note as the notes list renders it (ADR 0031). */
export interface PropertyNoteView {
  id: string
  property_id: string
  kind: string
  body: string | null
  file_name: string | null
  file_size: number | null
  file_url: string | null
  created_at: string
  author_name: string | null
}

/**
 * Active notes on the given properties, newest first, with author names and
 * 1-hour file links. property_note RLS scopes the rows (staff + council). A
 * failed read returns null (shown as "couldn't load") — never an empty list,
 * which would read as "no permission-to-enter form on file".
 */
export async function loadPropertyNotes(
  supabase: ServerSupabase,
  propertyIds: string[],
): Promise<PropertyNoteView[] | null> {
  if (propertyIds.length === 0) return []

  const { data: rows, error } = await supabase
    .from('property_note')
    .select('id, property_id, kind, body, file_path, file_name, file_size, created_at, created_by')
    .in('property_id', propertyIds)
    .is('removed_at', null)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[property notes] load failed:', error.message)
    return null
  }
  if (rows.length === 0) return []

  // Staff names via the DEFINER resolver — a direct profiles read is
  // RLS-hidden for other staff (council users would see a blank author).
  const authorIds = Array.from(new Set(rows.map((r) => r.created_by)))
  const { data: names } = await supabase.rpc('resolve_actor_names', { p_user_ids: authorIds })
  const authorById = new Map((names ?? []).map((n) => [n.user_id, n.name]))

  const paths = rows.flatMap((r) => (r.file_path ? [r.file_path] : []))
  const urlByPath = new Map<string, string>()
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from(PROPERTY_DOCUMENTS_BUCKET)
      .createSignedUrls(paths, 60 * 60)
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl)
    }
  }

  return rows.map((r) => ({
    id: r.id,
    property_id: r.property_id,
    kind: r.kind,
    body: r.body,
    file_name: r.file_name,
    file_size: r.file_size,
    file_url: r.file_path ? (urlByPath.get(r.file_path) ?? null) : null,
    created_at: r.created_at,
    author_name: authorById.get(r.created_by) ?? null,
  }))
}
