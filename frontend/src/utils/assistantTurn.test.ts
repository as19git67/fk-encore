import { describe, it, expect } from 'vitest'
import { applyEvent, emptyTurn, suggestedQuestions, toolLabel, type LiveTurn } from './assistantTurn'
import type { StreamEvent } from '../api/assistant'

function play(events: StreamEvent[]): LiveTurn {
  return events.reduce(applyEvent, emptyTurn())
}

describe('applyEvent', () => {
  it('streams tokens into the answer', () => {
    const t = play([{ type: 'token', text: 'Hal' }, { type: 'token', text: 'lo.' }])
    expect(t.text).toBe('Hallo.')
    expect(t.finished).toBe(false)
  })

  it('starts the text afresh when a tool is called', () => {
    const t = play([
      { type: 'token', text: 'Ich sehe nach …' },
      { type: 'tool_start', tool: 'list_transactions', arguments: { q: 'Miete' } },
    ])
    expect(t.text).toBe('')
    expect(t.steps).toEqual([{ tool: 'list_transactions', label: 'Buchungen durchsuchen', done: false }])
  })

  it('closes the step and keeps the block a tool returned', () => {
    const block = { kind: 'transactions' as const, tool: 'list_transactions', rows: [{ id: 1 }] }
    const t = play([
      { type: 'tool_start', tool: 'list_transactions' },
      { type: 'tool_result', tool: 'list_transactions', row_count: 1, block },
    ])
    expect(t.steps[0]).toMatchObject({ done: true, rowCount: 1 })
    expect(t.blocks).toEqual([block])
  })

  it('takes the final answer and blocks from done', () => {
    const block = { kind: 'debits' as const, tool: 'upcoming_direct_debits', rows: [] }
    const t = play([
      { type: 'tool_start', tool: 'upcoming_direct_debits' },
      { type: 'token', text: 'Bis Monatsende …' },
      { type: 'done', answer: 'Bis Monatsende kommt nichts mehr.', blocks: [block] },
      { type: 'token', text: 'ignored' },
    ])
    expect(t).toMatchObject({ text: 'Bis Monatsende kommt nichts mehr.', blocks: [block], finished: true })
    expect(t.steps[0].done).toBe(true)
  })

  it('reports an error and stops', () => {
    const t = play([{ type: 'error', message: 'Modell beschäftigt' }])
    expect(t).toMatchObject({ finished: true, error: 'Modell beschäftigt' })
  })
})

describe('helpers', () => {
  it('labels known and unknown tools', () => {
    expect(toolLabel('search_documents')).toBe('Dokumente durchsuchen')
    expect(toolLabel('some_new_tool')).toBe('some new tool')
  })

  it('suggests one question per module the user has', () => {
    expect(suggestedQuestions((p) => p === 'finance.view' || p === 'meters.view')).toHaveLength(2)
    expect(suggestedQuestions(() => false)).toEqual([])
  })
})
