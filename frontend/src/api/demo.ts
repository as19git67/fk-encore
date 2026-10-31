import { apiFetch } from './client'

/** What the system holds besides demo rows, per kind (demo/state.ts). */
export interface DemoContentCounts {
  users: number
  photos: number
  documents: number
  transactions: number
  depot_transactions: number
  meter_readings: number
  trip_plans: number
}

export type DemoRunStatus = 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled' | 'removing' | 'removed'

export interface DemoRun {
  id: number
  status: DemoRunStatus
  stage: string | null
  size: 'full' | 'small'
  text_source: 'llm' | 'template'
  progress: Record<string, { done: number; total: number }>
  summary: Record<string, number> | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface DemoStatus {
  untouched: boolean
  counts: DemoContentCounts
  run: DemoRun | null
}

export function getDemoStatus() {
  return apiFetch<DemoStatus>('/admin/demo/status', { timeoutMs: 15000 })
}

export function startDemo(text: 'llm' | 'template' = 'llm') {
  return apiFetch<DemoStatus>('/admin/demo/start', { method: 'POST', body: JSON.stringify({ text }) })
}

export function cancelDemo() {
  return apiFetch<DemoStatus>('/admin/demo/cancel', { method: 'POST' })
}

export function removeDemo() {
  return apiFetch<DemoStatus>('/admin/demo/remove', { method: 'POST' })
}

export type DemoTruthField = 'category' | 'document_type' | 'sender' | 'date' | 'tax_role'

/** How well the pipeline read the demo documents (demo/truth.ts). */
export interface DemoTruthReport {
  documents: number
  pending: number
  failed: number
  fields: Array<{ field: DemoTruthField; compared: number; hits: number }>
  kinds: Array<{ kind: string; documents: number; category_hits: number; finished: number }>
}

export function getDemoTruth() {
  return apiFetch<DemoTruthReport>('/admin/demo/truth', { timeoutMs: 15000 })
}
