'use server'

import { createClient } from '@/lib/supabase/server'
import type { Result } from '@/lib/result'

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

export async function submitSurvey(
  token: string,
  responses: SurveyResponses
): Promise<Result<void>> {
  if (!token) {
    return { ok: false, error: 'Token is required.' }
  }

  const supabase = await createClient()

  // Validate token exists and hasn't been submitted
  const { data: survey, error: fetchError } = await supabase
    .from('booking_survey')
    .select('id, submitted_at')
    .eq('token', token)
    .single()

  if (fetchError || !survey) {
    return { ok: false, error: 'Survey not found.' }
  }

  if (survey.submitted_at) {
    return { ok: false, error: 'This survey has already been submitted.' }
  }

  const { error: updateError } = await supabase
    .from('booking_survey')
    .update({
      responses: responses as unknown as { [key: string]: string | number },
      submitted_at: new Date().toISOString(),
    })
    .eq('id', survey.id)

  if (updateError) {
    return { ok: false, error: updateError.message }
  }

  return { ok: true, data: undefined }
}
