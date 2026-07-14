import { describe, expect, it } from 'vitest'
import { resolveLabelPlaceholders } from './labelPlaceholders'

describe('resolveLabelPlaceholders', () => {
  it('resolves date, time and user placeholders in German format', () => {
    const now = new Date(2026, 6, 14, 9, 5)
    expect(
      resolveLabelPlaceholders(
        '{{datum}} | {{uhrzeit}} | {{datum_zeit}} | {{jahr}} | {{monat}} | {{benutzer}}',
        now,
        'Anton',
      ),
    ).toBe('14.07.2026 | 09:05 | 14.07.2026 09:05 | 2026 | Juli | Anton')
  })

  it('replaces repeated placeholders', () => {
    expect(resolveLabelPlaceholders('{{jahr}}/{{jahr}}', new Date(2026, 0, 1))).toBe('2026/2026')
  })
})
