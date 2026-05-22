// scripts/lib/types.ts
// Shared types for the VV import, MUD import, and hygiene scripts.

/** Airtable record ID (e.g. "rec00ANo7vIwiCTTo"). */
export type AirtableRecordId = string

/** Verco eligible_properties row ID. */
export type EligiblePropertyId = string

/**
 * One Verge Valet base in Airtable. The three are structural clones
 * (same table + field IDs) so they share field-ID constants but live
 * at different baseIds with different data.
 */
export type VvBase = {
  key: 'main' | 'sub' | 'vic'
  baseId: string
  /** Whether this base's Eligible Properties rows have lat/long fields. */
  hasGeocode: boolean
}

export const VV_BASES: readonly VvBase[] = [
  { key: 'main', baseId: 'appWSysd50QoVaaRD', hasGeocode: true  },
  { key: 'sub',  baseId: 'appuf7kTSNFXi7Rp0', hasGeocode: false },
  { key: 'vic',  baseId: 'appIgPfNX8SYS9QIq', hasGeocode: false },
] as const

/** Airtable record IDs are stable per-base. The (baseId, recordId) pair is globally unique. */
export type AirtableEligibleProperty = {
  id: AirtableRecordId
  address: string
  /** Council_Code linked-record name (the council code, e.g. "FRE-S"). One value expected. */
  councilCode: string | null
  /** Only present on the Main base. Null on SUB + VIC. */
  latitude: number | null
  longitude: number | null
}

/** Single result row from the Google Geocoding API. */
export type GeocodeResult = {
  lat: number
  lng: number
  placeId: string
  formattedAddress: string
}

/** Verco eligible_properties INSERT shape (matches the table columns after migration). */
export type EligiblePropertyInsert = {
  collection_area_id: string
  address: string
  formatted_address: string | null
  latitude: number | null
  longitude: number | null
  google_place_id: string | null
  has_geocode: boolean
  is_mud: boolean
  external_source: string
  external_id: string
}

// ─── MUD-specific types ───────────────────────────────────────────────────────

/** One record from the Airtable MUD List table (council code pre-resolved). */
export type AirtableMudRecord = {
  /** Airtable record ID — used as external_id for idempotency. */
  id: AirtableRecordId
  address: string
  mudRef: string | null
  units: number
  /** Raw Airtable singleSelect name: "Registered" | "Inactive" | null */
  status: string | null
  contactName: string | null
  contactNumber: string | null
  email: string | null
  notes: string | null
  /** Raw Airtable number (0, 2, 3, 6, 12 …). 0 = not set / ad-hoc. */
  frequencyMonths: number
  offStreetAgreed: boolean
  /** Council code name (e.g. "FRE-S") resolved from Airtable linked record. */
  councilCodeName: string | null
  /** First attachment URL from the Registration Form field (Airtable signed URL — expires). */
  authFormUrl: string | null
  authFormFilename: string | null
}

/** Verco eligible_properties INSERT shape for MUD records (pass 1 — no auth_form_url yet). */
export type MudPropertyInsert = EligiblePropertyInsert & {
  is_mud: true
  unit_count: number
  mud_code: string | null
  mud_onboarding_status: 'Contact Made' | 'Registered' | 'Inactive'
  collection_cadence: 'Ad-hoc' | 'Annual' | 'Bi-annual' | 'Quarterly'
  waste_location_notes: string | null
  strata_contact_id: string | null
}
