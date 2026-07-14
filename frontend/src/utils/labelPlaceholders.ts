export interface LabelPlaceholder {
  token: string
  label: string
  example: string
}

export const LABEL_PLACEHOLDERS: LabelPlaceholder[] = [
  { token: '{{datum}}', label: 'Aktuelles Datum', example: '14.07.2026' },
  { token: '{{uhrzeit}}', label: 'Aktuelle Uhrzeit', example: '09:30' },
  { token: '{{datum_zeit}}', label: 'Datum und Uhrzeit', example: '14.07.2026 09:30' },
  { token: '{{jahr}}', label: 'Aktuelles Jahr', example: '2026' },
  { token: '{{monat}}', label: 'Aktueller Monat', example: 'Juli' },
  { token: '{{benutzer}}', label: 'Benutzername', example: 'Anton' },
]

export function resolveLabelPlaceholders(
  text: string,
  now: Date = new Date(),
  userName = '',
): string {
  const date = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now)
  const time = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  const month = new Intl.DateTimeFormat('de-DE', { month: 'long' }).format(now)
  const replace = (value: string, token: string, replacement: string) =>
    value.split(token).join(replacement)

  let resolved = text
  resolved = replace(resolved, '{{datum_zeit}}', `${date} ${time}`)
  resolved = replace(resolved, '{{datum}}', date)
  resolved = replace(resolved, '{{uhrzeit}}', time)
  resolved = replace(resolved, '{{jahr}}', String(now.getFullYear()))
  resolved = replace(resolved, '{{monat}}', month)
  return replace(resolved, '{{benutzer}}', userName)
}
