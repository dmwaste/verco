import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TEMPLATE_CATALOG } from './registry'
import { TemplatesList } from './templates-list'

export default async function TemplatesPage() {
  // Contractor-internal — surfaces template content + source code that
  // client-admins shouldn't see. Matches the bug-reports gating pattern.
  const supabase = await createClient()
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'contractor-admin') {
    notFound()
  }

  return <TemplatesList entries={TEMPLATE_CATALOG} />
}
