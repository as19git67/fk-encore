import { describe, it, expect } from 'vitest'
import { assistantLocation, contextQuery, MAX_ASSISTANT_CONTEXT, parseContextQuery } from './assistantContext'

describe('assistant context in the URL', () => {
  it('round-trips a selection', () => {
    const refs = [{ type: 'document' as const, id: 12 }, { type: 'transaction' as const, id: 7 }, { type: 'photo' as const, id: 3 }]
    expect(parseContextQuery(contextQuery(refs))).toEqual(refs)
    expect(assistantLocation(refs, 'Entwirf eine Antwort.')).toEqual({
      path: '/assistent',
      query: { context: 'document:12,transaction:7,photo:3', prompt: 'Entwirf eine Antwort.' },
    })
  })

  it('drops what is not a ref and caps the set', () => {
    expect(parseContextQuery('document:1,album:2,document:x,photo:-3,,transaction:4')).toEqual([
      { type: 'document', id: 1 }, { type: 'transaction', id: 4 },
    ])
    expect(parseContextQuery(undefined)).toEqual([])
    const many = Array.from({ length: 40 }, (_, i) => `document:${i + 1}`).join(',')
    expect(parseContextQuery(many)).toHaveLength(MAX_ASSISTANT_CONTEXT)
  })
})
