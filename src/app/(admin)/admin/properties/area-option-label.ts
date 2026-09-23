/**
 * Label for a collection-area <option> in the admin properties page.
 * Staged-off areas (is_active = false) stay pickable so staff can load
 * properties before a council goes live, but are flagged because residents
 * can't book them yet.
 */
export function areaOptionLabel(area: { code: string; name: string; is_active: boolean }): string {
  const label = `${area.code} — ${area.name}`
  return area.is_active ? label : `${label} (not yet live)`
}
