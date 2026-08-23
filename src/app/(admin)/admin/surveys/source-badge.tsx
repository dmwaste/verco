import { SURVEY_SOURCE_AIRTABLE } from '@/lib/survey/legacy'

/** Small "Airtable" pill for imported legacy surveys; renders nothing for Verco-native rows. */
export function SurveySourceBadge({ source }: { source: string }) {
  if (source !== SURVEY_SOURCE_AIRTABLE) return null
  return <span className="rounded bg-gray-100 px-1.5 py-0.5 text-caption text-gray-500">Airtable</span>
}
