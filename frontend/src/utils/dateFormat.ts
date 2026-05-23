/**
 * Centralized date/location formatting utilities.
 * All photo-related dates use the browser locale; admin dates use 'de-DE'.
 */

/** Extract the local date from a Date object as YYYY-MM-DD. */
export function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a YYYY-MM-DD string as local midnight (not UTC). */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, m! - 1, d)
}

/**
 * Serialise a Date as `YYYY-MM-DDTHH:MM:SS` using the local wall-clock,
 * with no timezone offset. The backend's `taken_at` column is stored as
 * a wall-clock literal (timestamp without time zone), so sending the
 * user's local time as wall-clock keeps the displayed value stable
 * across the round-trip. `d.toISOString()` would convert the local time
 * to UTC first, which then gets stored as wall-clock — silently
 * shifting the time by the user's UTC offset (issue #433).
 */
export function toLocalIsoDateTime(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${mo}-${day}T${h}:${mi}:${s}`
}

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
