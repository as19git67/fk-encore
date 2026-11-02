/** Relative time for a feed card: „gerade eben“, „vor 5 min“, … then a date. */
export function formatFeedTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diffMin = Math.round((Date.now() - d.getTime()) / 60_000)
  if (diffMin < 1) return 'gerade eben'
  if (diffMin < 60) return `vor ${diffMin} min`
  const diffH = Math.round(diffMin / 60)
  if (diffH < 24) return `vor ${diffH} h`
  const diffD = Math.round(diffH / 24)
  if (diffD < 7) return `vor ${diffD} Tg.`
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Initials for the round avatar of a feed card. */
export function feedInitials(name: string): string {
  const n = name.trim()
  if (!n) return '?'
  const parts = n.split(/\s+/)
  return (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')
}
