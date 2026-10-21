/**
 * The nightly aesthetic run (documentation/plans/foto-aesthetik.md, stage 3):
 * window, state, history, and the manual start; and the provisional head
 * (stage 4) that scores photos the night has not reached.
 */

import { apiFetch } from './client'

export interface AestheticSettings {
  enabled: boolean
  /** Local time "HH:MM". */
  window_start: string
  window_end: string
  /** Adopted weights of the overall score for Q-Align photos; null keeps the original formula. */
  composite: CompositeSetting | null
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

/** The linear head on the CLIP vector in the embedding service. */
export interface AestheticHeadReport {
  version: string
  /** Used for new photos: beats the zero-shot prompts on the test photos. */
  active: boolean
  trained_at: string
  samples: number
  train: number
  validation: number
  test: number
  ridge_lambda: number
  /** Rank correlation with Q-Align on the test photos. */
  spearman_head: number
  spearman_zero_shot: number
  mae_head: number
}

export interface AestheticHeadJob {
  trigger: 'after_run' | 'manual'
  status: 'running' | 'done' | 'skipped' | 'failed'
  phase: 'train' | 'apply' | null
  applied: number
  without_vector: number
  note: string | null
  error: string | null
  report: AestheticHeadReport | null
  started_at: string
  ended_at: string | null
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
  head: AestheticHeadReport | null
  head_error: string | null
  head_pending: number | null
  head_job: AestheticHeadJob | null
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

export function trainAestheticHead(): Promise<{ started: boolean }> {
  return apiFetch('/photos/aesthetic/head/train', { method: 'POST' })
}

/** Deletes every finished run from the history; running or stranded ones stay. */
export function clearAestheticRuns(): Promise<{ deleted: number }> {
  return apiFetch('/photos/aesthetic/runs', { method: 'DELETE' })
}

export function deleteAestheticRun(id: number): Promise<{ deleted: number }> {
  return apiFetch(`/photos/aesthetic/runs/${id}`, { method: 'DELETE' })
}

// ─── Stage 5: replay the auto-pick with the Q-Align signal ─────────────────

export type ReplayVariantKey = 'current' | 'default' | 'fitted' | 'fitted_qalign'

export interface ReplayVariant {
  key: ReplayVariantKey
  label: string
  groups: number
  hits: number
  /** Share of groups whose top-ranked photo is one the user kept. */
  hit_rate: number
}

export interface ReplayReport {
  reviewed_groups: number
  decided_groups: number
  /** Decided groups whose photos all have a Q-Align score; the replay runs on these. */
  qalign_groups: number
  variants: ReplayVariant[]
  recommended: 'fitted' | 'fitted_qalign' | null
  /** Why nothing is recommended; null when something is. */
  reason: string | null
  min_groups: number
}

export function replayAutoPick(): Promise<ReplayReport> {
  return apiFetch('/photos/aesthetic/replay', { method: 'POST' })
}

export function adoptAutoPickReplay(): Promise<{ report: ReplayReport }> {
  return apiFetch('/photos/aesthetic/replay/adopt', { method: 'POST' })
}

// ─── The overall score without the CLIP prompts ─────────────────────────────

export interface CompositeWeights {
  aesthetics: number
  quality: number
  blur: number
}

export interface CompositeSetting {
  weights: CompositeWeights
  groups: number
  hit_rate_before: number
  hit_rate_after: number
  adopted_at: string
}

export interface CompositeVariant {
  key: 'current' | 'default' | 'fitted'
  label: string
  groups: number
  hits: number
  hit_rate: number
  /** Null for the original formula. */
  weights: CompositeWeights | null
}

export interface CompositeReport {
  /** Decided groups across all users. */
  decided_groups: number
  /** ...with Q-Align values throughout; the replay runs on these. */
  qalign_groups: number
  variants: CompositeVariant[]
  recommended: 'default' | 'fitted' | null
  reason: string | null
  min_groups: number
  adopted: CompositeSetting | null
}

export function replayCompositeScore(): Promise<CompositeReport> {
  return apiFetch('/photos/aesthetic/composite/replay', { method: 'POST' })
}

export function adoptCompositeScore(): Promise<CompositeReport> {
  return apiFetch('/photos/aesthetic/composite/adopt', { method: 'POST' })
}

export function resetCompositeScore(): Promise<void> {
  return apiFetch('/photos/aesthetic/composite/reset', { method: 'POST' })
}
