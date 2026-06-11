import { z } from 'zod'
import { ID_WASTE_TYPES, ID_VOLUMES, ID_PHOTOS_BUCKET } from './id-options'

// Validation + notes assembly shared by the two ID intake server actions
// (field ranger form and admin office-staff form). CLAUDE.md §8: every server
// action validates external input with zod — TS types vanish at runtime and
// server actions are network-callable endpoints.

const VOLUME_VALUES = ID_VOLUMES.map((v) => `${v.label} (${v.sub})`)

/** Photos must live in our own storage bucket — arbitrary URLs would be
 *  rendered as <img src> in admin/field surfaces. Fails CLOSED when the
 *  Supabase URL env is missing, except under vitest (unit tests run without
 *  the app env) where any https URL passes. */
function isAllowedPhotoUrl(url: string): boolean {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '')
  if (!base) {
    return process.env.NODE_ENV === 'test' ? url.startsWith('https://') : false
  }
  return url.startsWith(`${base}/storage/v1/object/public/${ID_PHOTOS_BUCKET}/`)
}

export const idIntakeSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  geo_address: z.string().max(500),
  collection_date_id: z.string().uuid(),
  collection_area_id: z.string().uuid(),
  waste_types: z.array(z.enum(ID_WASTE_TYPES)).min(1),
  volume: z.string().refine((v) => VOLUME_VALUES.includes(v), {
    message: 'Invalid volume',
  }),
  description: z.string().max(2000),
  photo_urls: z
    .array(z.string().url().max(2048).refine(isAllowedPhotoUrl, { message: 'Photo URL not allowed' }))
    .max(20),
  notes: z.string().max(2000),
})

export type IdIntakeInput = z.infer<typeof idIntakeSchema>

/** The unvalidated wire shape the forms submit — runtime validation via
 *  idIntakeSchema narrows it to IdIntakeInput inside the server actions. */
export interface IdIntakeSubmission {
  latitude: number
  longitude: number
  geo_address: string
  collection_date_id: string
  collection_area_id: string
  waste_types: string[]
  volume: string
  description: string
  photo_urls: string[]
  notes: string
}

/** The booking.notes column carries the two free-text fields; waste types,
 *  volume and photos persist in dedicated columns. */
export function buildIdNotes(description: string, notes: string): string {
  return [description, notes]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
}
