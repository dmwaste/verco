/**
 * Legacy (Airtable-imported) survey identity — ADR 0016.
 *
 * `booking_survey.external_ref` for `source = 'airtable'` rows is
 * `<Airtable Booking_Ref>|<Create Date>` (the importer's idempotency key).
 * Readers show the ref half; the date half only disambiguates double-submits.
 */
export const SURVEY_SOURCE_AIRTABLE = 'airtable'
export const SURVEY_SOURCE_VERCO = 'verco'

export function legacySurveyRef(externalRef: string | null | undefined): string | null {
  const ref = externalRef?.split('|')[0]?.trim()
  return ref ? ref : null
}

/** Display ref for any survey row: the Verco booking ref, else the Airtable ref. */
export function surveyDisplayRef(bookingRef: string | null | undefined, externalRef: string | null | undefined): string | null {
  return bookingRef ?? legacySurveyRef(externalRef)
}
