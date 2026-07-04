'use server'

import { createClient } from '@/lib/supabase/server'
import type { Result } from '@/lib/result'
import { validateResponses } from '@/lib/survey/questions'
import type { Json } from '@/lib/supabase/types'

/** The response shape the survey form builds (fixed core question set). */
export interface SurveyResponses {
  attempted_repair: string
  attempted_sell: string
  booking_rating: number
  booking_comments: string
  collection_rating: number
  collection_comments: string
  overall_rating: number
  prefer_service: string
  other_comments: string
}

/**
 * Submit a survey by token. Server-authoritative validation runs against the
 * fixed SURVEY_QUESTIONS set (unknown keys / missing required / bad ratings all
 * rejected here), then the SECURITY DEFINER RPC does the single-submission
 * guard (FOR UPDATE) and the write. booking_survey has no anon UPDATE policy,
 * so this MUST go through the RPC.
 */
export async function submitSurvey(
  token: string,
  responses: SurveyResponses,
): Promise<Result<void>> {
  if (!token) {
    return { ok: false, error: 'Token is required.' }
  }

  const validated = validateResponses(responses)
  if (!validated.ok) {
    return { ok: false, error: validated.error }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('submit_survey_by_token', {
    p_token: token,
    p_responses: validated.data as Json,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const result = (data ?? {}) as { ok?: boolean; error?: string }
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Could not submit survey.' }
  }

  return { ok: true, data: undefined }
}
