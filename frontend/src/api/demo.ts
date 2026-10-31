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

export function startDemo() {
  return apiFetch<DemoStatus>('/admin/demo/start', { method: 'POST', body: JSON.stringify({}) })
}

export function cancelDemo() {
  return apiFetch<DemoStatus>('/admin/demo/cancel', { method: 'POST' })
}

export function removeDemo() {
  return apiFetch<DemoStatus>('/admin/demo/remove', { method: 'POST' })
}
