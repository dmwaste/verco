/**
 * RS — Resident Satisfaction insight card (VER-179, spec §3.10).
 *
 * Pure + deterministic: no Supabase, no network, no wall-clock reads. The caller
 * (reports-client) fetches submitted-only `booking_survey` rows — already
 * RLS-scoped + client/area-filtered — and hands the opaque `responses` jsonb
 * blob in untouched. This fn extracts the single `overall_rating` field and
 * folds it into a satisfaction percentage.
 *
 * Definition: `(surveys with overall_rating ≥ 4) / (submitted surveys with a
 * valid 1..5 overall_rating) × 100`. Reference target ≥ 75% (WMRC RS KPI) —
 * rendered as an insight, never pass/fail.
 *
 * Rating extraction is `Number(responses.overall_rating)` per spec — never a
 * PostgREST jsonb `.gte`, because jsonb text compares lexically ('10' < '4').
 * A rating is counted only when it is a finite integer in 1..5; everything else
 * (null, NaN, out-of-range, non-integer, non-numeric junk, malformed blob) is
 * skipped so the denominator only ever reflects genuine ratings. `good` is
 * `rating >= 4`.
 */

/** WMRC resident-satisfaction reference target (%). Insight only — never pass/fail. */
export const RS_TARGET_PCT = 75

/**
 * Minimum valid-rating sample before a % headline is shown. Below this the card
 * shows the raw "good of n" fraction + "Building data" (spec §3.10). Exported so
 * it is testable + tunable.
 */
export const RS_LOW_N = 5

export interface ResidentSatisfactionRow {
  /** The survey's `responses` jsonb blob — opaque; shape is not trusted. */
  responses: unknown
}

export interface ResidentSatisfactionResult {
  /** Count of rows with a valid 1..5 integer overall_rating (the denominator). */
  n: number
  /** Count of valid ratings that are >= 4 (the numerator). */
  good: number
  /** Satisfaction % (0–100), or null when there are no valid ratings. */
  pct: number | null
  /** True when there are no valid ratings (n === 0). */
  isEmpty: boolean
  /** True when 0 < n < RS_LOW_N — show the raw fraction, no % headline. */
  isLowN: boolean
}

/**
 * Pull a valid 1..5 integer rating out of a single `responses` blob, or null.
 * Defensive on every layer: the blob may be null / a primitive / an array /
 * missing the key, and the value may be any JSON type.
 */
function extractRating(responses: unknown, key: SurveyRatingKey): number | null {
  if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) {
    return null
  }
  const raw = (responses as Record<string, unknown>)[key]
  // Only a number or numeric string is a genuine rating. Excluding booleans is
  // deliberate: `Number(true) === 1` would otherwise smuggle `true` in as a
  // rating of 1. (The survey form writes a JSON number; a numeric string is
  // tolerated defensively.)
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return null
  }
  const rating = Number(raw)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return null
  }
  return rating
}

/**
 * The three ratings the survey form writes (survey-form.tsx): booking
 * experience, the collection itself, and overall. The Customer Satisfaction
 * section renders one card per key (design feedback 02/07).
 */
export type SurveyRatingKey = 'booking_rating' | 'collection_rating' | 'overall_rating'

/** Fold one rating key across survey rows — same denominator rules per key. */
export function computeSurveyRating(
  rows: ResidentSatisfactionRow[],
  key: SurveyRatingKey,
): ResidentSatisfactionResult {
  let n = 0
  let good = 0

  for (const r of rows) {
    const rating = extractRating(r?.responses, key)
    if (rating === null) continue
    n += 1
    if (rating >= 4) good += 1
  }

  if (n === 0) {
    return { n: 0, good: 0, pct: null, isEmpty: true, isLowN: false }
  }

  return {
    n,
    good,
    pct: (good / n) * 100,
    isEmpty: false,
    isLowN: n < RS_LOW_N,
  }
}

/** Overall-rating fold — kept as the original single-metric entry point. */
export function computeResidentSatisfaction(
  rows: ResidentSatisfactionRow[],
): ResidentSatisfactionResult {
  return computeSurveyRating(rows, 'overall_rating')
}

export interface ServicePreferenceResult {
  yes: number
  no: number
  indifferent: number
  /** yes + no + indifferent — rows with a recognised answer. */
  total: number
}

/**
 * "Would you prefer this service over traditional bulk verge collection?"
 * (survey `responses.prefer_service`, options Yes / No / Indifferent —
 * design 02/07 batch 5 donut). Same defensive posture as the rating fold:
 * only recognised answers count; case/whitespace tolerated.
 */
export function computeServicePreference(
  rows: ResidentSatisfactionRow[],
): ServicePreferenceResult {
  let yes = 0
  let no = 0
  let indifferent = 0
  for (const r of rows) {
    const responses = r?.responses
    if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) continue
    const raw = (responses as Record<string, unknown>).prefer_service
    if (typeof raw !== 'string') continue
    const answer = raw.trim().toLowerCase()
    if (answer === 'yes') yes += 1
    else if (answer === 'no') no += 1
    else if (answer === 'indifferent') indifferent += 1
  }
  return { yes, no, indifferent, total: yes + no + indifferent }
}
