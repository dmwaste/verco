/**
 * Single source of truth for the resident satisfaction survey question set.
 *
 * The survey is a fixed, shared core set (not per-tenant) so its answers key on
 * stable jsonb ids that are directly comparable across every council — the
 * reporting in `lib/reports/resident-satisfaction.ts` and the Reports page read
 * those exact ids (`overall_rating`, `booking_rating`, `collection_rating`,
 * `prefer_service`). Per-tenant custom questions are a future capability
 * (see plan we-need-to-flesh-snappy-crayon.md, decision D2).
 *
 * This constant is consumed by the public survey form (render), the submit
 * server action (validation), the admin surveys detail view (labels + order),
 * and the CSV export (headers). The `id` values ARE the analytics keys —
 * never rename one; that would orphan every historical response.
 *
 * The option strings and labels reproduce the current hard-coded form exactly
 * (`app/(public)/survey/[token]/survey-form.tsx`); an option string is stored
 * verbatim as the response value, so it must match byte-for-byte.
 */

export type SurveyQuestionType = 'rating' | 'select' | 'radio' | 'text' | 'textarea'

export interface SurveyQuestion {
  /** Stable jsonb key written into `booking_survey.responses`. Never rename. */
  id: string
  type: SurveyQuestionType
  label: string
  required: boolean
  /** Section heading — questions render grouped, in array order. */
  section: string
  /** Present iff type is `select` or `radio`; the string is both value + display. */
  options?: readonly string[]
  /** Present only for `text` / `textarea`. */
  placeholder?: string
}

export const SURVEY_QUESTIONS: readonly SurveyQuestion[] = [
  {
    id: 'attempted_repair',
    type: 'select',
    section: 'About Your Collection',
    required: true,
    label: 'Did you attempt to repair or donate items before booking?',
    options: [
      'Yes — attempted repair',
      'Yes — donated or gave away',
      'No',
      'Not applicable',
    ],
  },
  {
    id: 'attempted_sell',
    type: 'select',
    section: 'About Your Collection',
    required: true,
    label: 'Did you attempt to sell or rehome items before booking?',
    options: [
      'Yes — sold online (e.g. Facebook Marketplace)',
      'Yes — gave to family/friends',
      'No',
      'Not applicable',
    ],
  },
  {
    id: 'booking_rating',
    type: 'rating',
    section: 'Booking Feedback',
    required: true,
    label: 'Booking experience rating',
  },
  {
    id: 'booking_comments',
    type: 'textarea',
    section: 'Booking Feedback',
    required: false,
    label: 'Booking comments',
    placeholder: 'Tell us about your booking experience — was it easy to use?',
  },
  {
    id: 'collection_rating',
    type: 'rating',
    section: 'Collection Feedback',
    required: true,
    label: 'Collection service rating',
  },
  {
    id: 'collection_comments',
    type: 'textarea',
    section: 'Collection Feedback',
    required: false,
    label: 'Collection comments',
    placeholder: 'How was the collection itself? Was everything picked up as expected?',
  },
  {
    id: 'overall_rating',
    type: 'rating',
    section: 'Overall Feedback',
    required: true,
    label: 'Overall rating',
  },
  {
    id: 'prefer_service',
    type: 'radio',
    section: 'Overall Feedback',
    required: true,
    label: 'Would you prefer this service over traditional bulk verge collection?',
    options: ['Yes', 'No', 'Indifferent'],
  },
  {
    id: 'other_comments',
    type: 'textarea',
    section: 'Overall Feedback',
    required: false,
    label: "Any other comments?",
    placeholder: "Anything else you'd like to share about your experience...",
  },
] as const

/** The rating question ids, in form order. These are the reporting keys. */
export const SURVEY_RATING_IDS = SURVEY_QUESTIONS.filter((q) => q.type === 'rating').map(
  (q) => q.id,
)

/** Validated + coerced responses — arbitrary question-id keys, ratings as numbers. */
export type ValidatedResponses = Record<string, string | number>

export interface SurveySection {
  section: string
  questions: SurveyQuestion[]
}

/** Group the questions into ordered sections (first appearance wins). */
export function surveySections(): SurveySection[] {
  const out: SurveySection[] = []
  for (const q of SURVEY_QUESTIONS) {
    let bucket = out.find((s) => s.section === q.section)
    if (!bucket) {
      bucket = { section: q.section, questions: [] }
      out.push(bucket)
    }
    bucket.questions.push(q)
  }
  return out
}

import type { Result } from '@/lib/result'
import { ok, err } from '@/lib/result'

/**
 * Validate + coerce a raw responses object against the fixed question set.
 * Server-authoritative — the submit server action calls this before writing.
 * Rejects unknown keys, missing required answers, out-of-range ratings, choice
 * values not in the option list, and over-long text. Ratings are coerced to
 * numbers so the stored jsonb compares numerically (never lexically) downstream.
 */
export function validateResponses(responses: unknown): Result<ValidatedResponses> {
  if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) {
    return err('Invalid responses.')
  }
  const input = responses as Record<string, unknown>
  const known = new Set(SURVEY_QUESTIONS.map((q) => q.id))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) return err(`Unknown field: ${key}`)
  }

  const out: ValidatedResponses = {}
  for (const q of SURVEY_QUESTIONS) {
    const raw = input[q.id]
    const present = raw !== undefined && raw !== null && raw !== ''
    if (!present) {
      if (q.required) return err(`Please answer: ${q.label}`)
      continue
    }
    switch (q.type) {
      case 'rating': {
        if (typeof raw !== 'number' && typeof raw !== 'string') {
          return err(`Invalid rating for: ${q.label}`)
        }
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          return err(`Invalid rating for: ${q.label}`)
        }
        out[q.id] = n
        break
      }
      case 'select':
      case 'radio': {
        if (typeof raw !== 'string' || !(q.options ?? []).includes(raw)) {
          return err(`Invalid selection for: ${q.label}`)
        }
        out[q.id] = raw
        break
      }
      case 'text':
      case 'textarea': {
        if (typeof raw !== 'string') return err(`Invalid text for: ${q.label}`)
        if (raw.length > 2000) {
          return err(`${q.label} is too long (max 2000 characters).`)
        }
        out[q.id] = raw
        break
      }
    }
  }
  return ok(out)
}
