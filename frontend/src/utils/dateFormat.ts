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
  return parts.join(', ')
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
