/**
 * The assistant benchmark (documentation/plans/ki-assistent.md,
 * "Benchmark"): cases, runs and their results.
 */

import { apiFetch } from './client'

export interface BenchCaseInfo {
  id: string
  title: string
  question: string
  tools: string[]
}

export interface BenchModel {
  label: string
  model_filename: string
  backend: string
  ctx_size: number
  /** `cpu` or `cuda`; missing on runs filed before the GPU lease existed. */
  accelerator?: string
  /** 0 = nothing on the card: the run was the CPU twin. */
  gpu_layers?: number
  /** `env`, `file` or `lease`. */
  source?: string
}

/** `loaded` measures what llm-service is running; `cpu` lends the GPU for the run and measures the CPU twin. */
export type BenchDevice = 'loaded' | 'cpu'

/** Stand-ins in `current_case` while the GPU changes hands. */
export const PHASE_LEND = 'gpu:lend'
export const PHASE_RETURN = 'gpu:return'

export interface BenchSummary {
  cases: number
  passed: number
  tool_hit_rate: number
  args_hit_rate: number
  pass_rate: number
  errors: number
  rounds: number
  median_ms_per_round: number | null
  p90_ms_per_round: number | null
  median_rounds_per_case: number | null
  max_rounds_used: number | null
  /** The road taken (stage 6 of assistent-wegfindung.md); missing on older runs. */
  first_tool_hit_rate?: number | null
  nudges?: number
  median_prompt_tokens_first?: number | null
  /** Cases per router stage (stage 1); missing on older runs. */
  routed?: Partial<Record<'keywords' | 'inherited' | 'model' | 'all', number>>
  /** Tools written for the model (stage 2): empty results followed by another call, errors followed by a corrected call. */
  empty_follow_rate?: number | null
  error_fix_rate?: number | null
  /** The plan of multi-step questions (stage 3): cases asked for a plan, cases that got one, pass rate and rounds of the multi-area cases. */
  plan_asked?: number
  planned?: number
  multi_area_pass_rate?: number | null
  median_rounds_multi_area?: number | null
  /** Pass rate of the cases that come with earlier turns (stage 4: history as summaries). */
  follow_up_pass_rate?: number | null
  /** The checker (stage 5): check calls, how many objected, answers that went out with a note, median time of a check. */
  checks?: number
  check_failed?: number
  unverified?: number
  median_check_ms?: number | null
}

export type BenchStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface BenchRunSummary {
  id: number
  label: string
  model: BenchModel | null
  status: BenchStatus
  cases_total: number
  cases_done: number
  current_case: string | null
  summary: BenchSummary | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface BenchCaseRun {
  id: string
  title: string
  rounds_ms: number[]
  calls: { tool: string; args: Record<string, unknown> }[]
  answer: string | null
  error: string | null
  score: { tool_hit: boolean; args_hit: boolean; answered: boolean; passed: boolean; missing: string[]; first_tool_hit?: boolean | null }
  /** The road taken; missing on older runs. */
  rounds?: number
  first_tool?: string | null
  nudges?: number
  prompt_tokens_first?: number | null
  /** The router (stage 1 of assistent-wegfindung.md); missing on older runs. */
  areas?: string[]
  routing?: 'keywords' | 'inherited' | 'model' | 'all'
  router_ms?: number | null
  /** Stage 2: empty results and tool errors of the turn, and how many the model followed up. */
  empty_results?: number
  empty_followed?: number
  tool_errors?: number
  errors_corrected?: number
  /** Stage 3: the router asked for a plan; the planned tools and how many steps got done. */
  plan_asked?: boolean
  plan?: string[]
  plan_done?: number
  /** Stage 4: the case came with earlier turns. */
  follow_up?: boolean
  /** Stage 5: check calls of the turn, how many objected, and whether the answer went out with a note. */
  checks?: number
  check_failed?: number
  check_ms?: number | null
  unverified?: boolean
}

/** One call of the turn behind an answer the user judged: never the rows it returned. */
export interface FeedbackTraceEntry {
  tool: string
  arguments: Record<string, unknown>
  rows: number | null
  error: string | null
}

export interface FeedbackEntry {
  id: number
  verdict: 'up' | 'down'
  comment: string | null
  question: string
  trace: FeedbackTraceEntry[]
  answer: string
  conversation_id: number | null
  message_id: number | null
  created_at: string
  /** A benchmark case skeleton as JSON, to paste into `bench/cases.ts` after anonymising. */
  case_draft: string
}

export interface BenchRunDetail extends BenchRunSummary {
  results: BenchCaseRun[]
}

export function listBenchCases(): Promise<{ today: string; cases: BenchCaseInfo[] }> {
  return apiFetch('/assistant/benchmark/cases')
}

export function listBenchRuns(): Promise<{ runs: BenchRunSummary[] }> {
  return apiFetch('/assistant/benchmark/runs')
}

export function getBenchRun(id: number): Promise<BenchRunDetail> {
  return apiFetch(`/assistant/benchmark/runs/${id}`)
}

export function startBenchRun(body: { label?: string; case_ids?: string[]; device?: BenchDevice }): Promise<BenchRunDetail> {
  return apiFetch('/assistant/benchmark/runs', { method: 'POST', body: JSON.stringify(body) })
}

export function cancelBenchRun(id: number): Promise<BenchRunSummary> {
  return apiFetch(`/assistant/benchmark/runs/${id}/cancel`, { method: 'POST' })
}

export function deleteBenchRun(id: number): Promise<{ deleted: boolean }> {
  return apiFetch(`/assistant/benchmark/runs/${id}`, { method: 'DELETE' })
}

export function listFeedback(): Promise<{ entries: FeedbackEntry[] }> {
  return apiFetch('/assistant/feedback')
}

export function deleteFeedback(id: number): Promise<{ deleted: boolean }> {
  return apiFetch(`/assistant/feedback/${id}`, { method: 'DELETE' })
}
