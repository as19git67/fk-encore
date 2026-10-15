/**
 * What a running assistant turn looks like on screen, built from the stream's
 * events (#1528). Pure, so the page and its test share one reading of them.
 *
 * Text belongs to the round it arrives in: the model may write a sentence
 * before it calls tools, so a `tool_start` begins the answer afresh, and
 * `done` carries the final answer either way.
 */

import type { ResultBlock, StreamEvent } from '../api/assistant'

export interface TurnStep {
  tool: string
  label: string
  done: boolean
  rowCount?: number
  error?: string
}

export interface LiveTurn {
  text: string
  steps: TurnStep[]
  blocks: ResultBlock[]
  finished: boolean
  error?: string
}

export function emptyTurn(): LiveTurn {
  return { text: '', steps: [], blocks: [], finished: false }
}

const TOOL_LABELS: Record<string, string> = {
  list_accounts: 'Konten ansehen',
  list_transactions: 'Buchungen durchsuchen',
  analyze_spending: 'Ausgaben auswerten',
  upcoming_direct_debits: 'Lastschriften vorausberechnen',
  list_categories: 'Kategorien ansehen',
  search_documents: 'Dokumente durchsuchen',
  get_document_summary: 'Dokument lesen',
  list_photos: 'Fotos durchsuchen',
  search_photos: 'Fotos nach Inhalt suchen',
  list_recaps: 'Rückblicke ansehen',
  list_albums: 'Alben ansehen',
  list_persons: 'Personen ansehen',
  list_meters: 'Zähler ansehen',
  latest_readings: 'Zählerstände lesen',
  consumption_report: 'Verbrauch berechnen',
  list_trip_plans: 'Reisepläne ansehen',
  create_album: 'Album vorschlagen',
  add_photos_to_album: 'Fotos für ein Album vorschlagen',
  set_photo_favorite: 'Favoriten vorschlagen',
  create_document_follow_up: 'Wiedervorlage vorschlagen',
  tag_transactions: 'Tags vorschlagen',
}

/** What the user reads while a tool runs. */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ')
}

export function applyEvent(turn: LiveTurn, event: StreamEvent): LiveTurn {
  if (turn.finished) return turn
  switch (event.type) {
    case 'token':
      return { ...turn, text: turn.text + (event.text ?? '') }
    case 'tool_start': {
      const tool = event.tool ?? 'tool'
      return { ...turn, text: '', steps: [...turn.steps, { tool, label: toolLabel(tool), done: false }] }
    }
    case 'tool_result': {
      let closed = false
      const steps = turn.steps.map((s) => {
        if (closed || s.done || s.tool !== event.tool) return s
        closed = true
        return { ...s, done: true, rowCount: event.row_count, error: event.error }
      })
      return { ...turn, steps, blocks: event.block ? [...turn.blocks, event.block] : turn.blocks }
    }
    case 'done':
      return {
        ...turn,
        text: event.answer ?? turn.text,
        blocks: event.blocks ?? turn.blocks,
        steps: turn.steps.map((s) => ({ ...s, done: true })),
        finished: true,
      }
    case 'error':
      return { ...turn, finished: true, error: event.message ?? 'Unbekannter Fehler' }
    default:
      return turn
  }
}

/** First questions on an empty page, one per module the user has. */
export function suggestedQuestions(has: (permission: string) => boolean): string[] {
  const out: string[] = []
  if (has('finance.view')) out.push('Welche Lastschriften muss ich in diesem Monat noch erwarten?')
  if (has('documents.view')) out.push('Welche Versicherungsunterlagen habe ich letztes Jahr bekommen?')
  if (has('photos.view')) out.push('Welche Urlaubsreisen haben wir letztes Jahr gemacht?')
  if (has('meters.view')) out.push('Wie viel Strom haben wir letztes Jahr verbraucht?')
  return out
}
