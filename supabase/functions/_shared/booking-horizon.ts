/**
 * How far ahead a RESIDENT booking may be made (ADR 0029, 13/10/2026).
 *
 * The collection calendar now runs ~12 months ahead so staff can schedule MUD
 * collections a year out (WMRC). Residents keep the 16 weeks they always had:
 * that is what the calendar used to hold, and a booking past the next 30 June
 * would otherwise be priced against the wrong financial year's allowance. MUD
 * bookings go through their own page + RPC and are not capped by this.
 *
 * Used by the resident date picker (display) AND create-booking (enforcement),
 * which also covers staff booking on a resident's behalf through the wizard.
 * Dates are AWST calendar dates ("YYYY-MM-DD").
 */
export const RESIDENT_BOOKING_HORIZON_DAYS = 112

/** First date residents can NOT book (exclusive end of the window). */
export function residentHorizonEnd(todayAwst: string): string {
  const d = new Date(`${todayAwst}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + RESIDENT_BOOKING_HORIZON_DAYS)
  return d.toISOString().slice(0, 10)
}

export function isWithinResidentHorizon(collectionDate: string, todayAwst: string): boolean {
  return collectionDate < residentHorizonEnd(todayAwst)
}
