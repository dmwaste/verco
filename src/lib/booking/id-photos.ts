// Photos persist in booking.photos (dedicated column, VER-225 onward). Early
// MVP rows stored only a "Photos: N" count inside booking.notes — keep that
// as a legacy fallback so old reports still show their count.
const PHOTO_COUNT_RE = /Photos:\s*(\d+)/

export function photoCount(
  photos: string[] | null | undefined,
  notes: string | null | undefined
): number {
  if (photos && photos.length > 0) return photos.length
  if (!notes) return 0
  const m = notes.match(PHOTO_COUNT_RE)
  return m && m[1] ? parseInt(m[1], 10) : 0
}
