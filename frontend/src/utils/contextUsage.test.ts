import { describe, it, expect } from 'vitest'
import { contextMeter, latestUsage } from './contextUsage'
import type { ContextUsage } from '../api/assistant'

const base: ContextUsage = {
  used: 12000, window: 30000, estimated: 14000, budget: 18976,
  historyTurns: 3, keptTurns: 3, digested: 0, earlierTurns: 3,
}

describe('contextMeter', () => {
  it('names the older turns that went as summaries (stage 4)', () => {
    const m = contextMeter({ ...base, historyTurns: 5, keptTurns: 5, earlierTurns: 5, summarizedTurns: 2 })
    expect(m.parts).toEqual(['12.000 von 30.000 Tokens', '5 von 5 früheren Fragen im Blick', '2 ältere als Zusammenfassung'])
    expect(m.description).toContain('2 ältere Fragen nur als Zusammenfassung ihrer Antwort.')
    expect(m.warn).toBe(false)
  })

  it('measures the model count against its window', () => {
    const m = contextMeter(base)
    expect(m.percent).toBe(40)
    expect(m.estimated).toBe(false)
    expect(m.warn).toBe(false)
    expect(m.parts).toEqual(['12.000 von 30.000 Tokens', '3 von 3 früheren Fragen im Blick'])
  })

  it('falls back to the estimate when the model gave no count', () => {
    const m = contextMeter({ ...base, used: null, window: null })
    expect(m.estimated).toBe(true)
    expect(m.parts[0]).toBe('ca. 14.000 von 18.976 Tokens (geschätzt)')
  })

  it('warns once earlier questions or results were shortened', () => {
    expect(contextMeter({ ...base, keptTurns: 1 }).warn).toBe(true)
    const m = contextMeter({ ...base, digested: 2 })
    expect(m.warn).toBe(true)
    expect(m.parts.at(-1)).toBe('2 Ergebnisse gekürzt')
  })

  it('names questions the loop never replayed', () => {
    const m = contextMeter({ ...base, historyTurns: 6, keptTurns: 6, earlierTurns: 11 })
    expect(m.parts[1]).toBe('6 von 11 früheren Fragen im Blick')
    expect(m.warn).toBe(true)
  })

  it('leaves out the history on a first question', () => {
    expect(contextMeter({ ...base, historyTurns: 0, keptTurns: 0, earlierTurns: 0 }).parts).toHaveLength(1)
  })
})

describe('latestUsage', () => {
  it('takes the newest answer that has one', () => {
    const older = { ...base, used: 1 }
    expect(latestUsage([
      { role: 'assistant', context_usage: older },
      { role: 'user' },
      { role: 'assistant', context_usage: null },
    ])).toBe(older)
    expect(latestUsage([{ role: 'user' }])).toBeNull()
  })
})
