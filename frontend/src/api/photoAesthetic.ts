/**
 * The nightly aesthetic run (documentation/plans/foto-aesthetik.md, stage 3):
 * window, state, history, and the manual start.
 */

import { apiFetch } from './client'

export interface AestheticSettings {
  enabled: boolean
  /** Local time "HH:MM". */
  window_start: string
  window_end: string
  updated_at: string
}

export type AestheticRunTrigger = 'window' | 'manual'
export type AestheticRunStatus = 'running' | 'done' | 'stopped' | 'failed'
export type ScorerState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'error'

/** What a running run is doing: `gpu:lend`, `scorer:load`, `scoring`, `scorer:unload`, `gpu:return`. */
export type AestheticPhase = string

export interface AestheticRun {
  id: number
  trigger: AestheticRunTrigger
  status: AestheticRunStatus
  phase: AestheticPhase | null
  model: string | null
  backlog: number
  scored: number
  failed: number
  remaining: number | null
  ended_reason: string | null
  error: string | null
  gpu_returned: boolean
  started_at: string
  ended_at: string | null
}

export interface ScorerStatus {
  state: ScorerState
  error: string | null
  version: string | null
}

export interface AestheticOverview {
  settings: AestheticSettings
  time_zone: string
  in_window: boolean
  model: string
  scored: number
  backlog: number
  active_run_id: number | null
  runs: AestheticRun[]
  scorer: ScorerStatus | null
  scorer_error: string | null
}

export interface StartAestheticRunResponse {
  started: boolean
  run_id: number | null
  reason: string | null
}

export function getAestheticOverview(): Promise<AestheticOverview> {
  return apiFetch('/photos/aesthetic')
}

export function saveAestheticSettings(body: Pick<AestheticSettings, 'enabled' | 'window_start' | 'window_end'>): Promise<AestheticSettings> {
  return apiFetch('/photos/aesthetic/settings', { method: 'PUT', body: JSON.stringify(body) })
}

export function startAestheticRun(): Promise<StartAestheticRunResponse> {
  return apiFetch('/photos/aesthetic/run', { method: 'POST' })
}

export function stopAestheticRun(): Promise<{ stopping: boolean }> {
  return apiFetch('/photos/aesthetic/stop', { method: 'POST' })
}

export function backfillAesthetic(model?: string): Promise<{ marked: number }> {
  return apiFetch('/photos/aesthetic/backfill', { method: 'POST', body: JSON.stringify(model ? { model } : {}) })
}
