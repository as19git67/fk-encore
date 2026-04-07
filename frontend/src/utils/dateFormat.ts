/**
 * Centralized date formatting utilities.
 * All photo-related dates use the browser locale; admin dates use 'de-DE'.
 */

/** Full photo date with time (for fullscreen overlay, sidebar, shared album) */
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

/** Short date/time for admin tables and lists */
export function formatDateShort(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('de-DE')
}
