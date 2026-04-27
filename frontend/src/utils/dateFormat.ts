/**
 * Centralized date/location formatting utilities.
 * All photo-related dates use the browser locale; admin dates use 'de-DE'.
 */

/** Compact location label: name + city, country only as fallback */
export function formatLocationLabel(loc: { location_name?: string; location_city?: string; location_country?: string }): string {
  const parts: string[] = []
  if (loc.location_name) parts.push(loc.location_name)
  if (loc.location_city) parts.push(loc.location_city)
  if (loc.location_country && !parts.length) parts.push(loc.location_country)

  // Reverse-geocoded `location_name` typically already contains the city
  // ("Weite Gasse 4, Augsburg") — appending `location_city` produces
  // "Weite Gasse 4, Augsburg, Augsburg". Walk every comma-separated
  // token across all parts and drop case-insensitive duplicates,
  // preserving the first occurrence's casing.
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    for (const raw of part.split(/,\s*/)) {
      const token = raw.trim()
      if (!token) continue
      const key = token.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(token)
    }
  }
  return out.join(', ')
}

/** Full photo date with time (for fullscreen overlay, shared album) */
export function formatPhotoDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(navigator.language, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/** Compact photo date (detail sidebar): no weekday, numeric date. */
export function formatPhotoDateCompact(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(navigator.language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/** Short date/time for admin tables and lists */
export function formatDateShort(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('de-DE')
}
