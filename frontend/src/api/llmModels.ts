import { apiFetch } from './client'

export type LlmBackend = 'inproc' | 'server'
export type LlmAccelerator = 'cpu' | 'cuda'
export type LlmKvType = 'f16' | 'q8_0' | 'q5_1' | 'q5_0' | 'q4_0'
export type LlmReasoning = 'off' | 'auto' | 'think'

export interface LlmConfigRow {
  id: number
  label: string
  description: string | null
  is_active: boolean
  model_filename: string
  model_url: string | null
  model_sha256: string | null
  extra_urls: string[]
  backend: LlmBackend
  accelerator: LlmAccelerator
  ctx_size: number
  gpu_layers: number
  threads: number | null
  batch_size: number
  ubatch_size: number
  flash_attn: boolean
  kv_type: LlmKvType
  n_cpu_moe: number
  reasoning: LlmReasoning
  server_extra_args: string | null
  ready_timeout_s: number
  request_timeout_s: number
  app_timeout_ms: number
  created_at: string
  updated_at: string
}

export interface LlmConfigInput {
  label: string
  description?: string | null
  model_filename: string
  model_url?: string | null
  model_sha256?: string | null
  extra_urls?: string[]
  backend?: LlmBackend
  accelerator?: LlmAccelerator
  ctx_size?: number
  gpu_layers?: number
  threads?: number | null
  batch_size?: number
  ubatch_size?: number
  flash_attn?: boolean
  kv_type?: LlmKvType
  n_cpu_moe?: number
  reasoning?: LlmReasoning
  server_extra_args?: string | null
  ready_timeout_s?: number
  request_timeout_s?: number
  app_timeout_ms?: number
}

/** `idle` → `stopping` → `downloading` → `loading` → `ready` / `error`. */
export interface LlmReloadState {
  state: string
  detail: string | null
  label: string
  started_at: number | null
  finished_at: number | null
}

export interface LlmLiveConfig {
  model_filename: string
  backend: string
  accelerator: string
  ctx_size: number
  gpu_layers: number
  n_cpu_moe: number
  kv_type: string
  flash_attn: boolean
  label: string
  config_id: number | null
  /** `env` = the container's environment, `file` = an activated configuration. */
  source: string
  model_present: boolean
}

export interface LlmDownloadState {
  state: string
  filename: string
  url: string
  bytes_done: number
  bytes_total: number | null
  percent: number | null
  eta_seconds: number | null
  bytes_per_second: number | null
  file_index: number
  file_count: number
  error: string | null
  completed: string[]
}

export interface LlmStatus {
  intended: LlmConfigRow | null
  live: LlmLiveConfig
  reload: LlmReloadState
  download: LlmDownloadState
  llm_loaded: boolean
  in_sync: boolean
}

export interface ModelFile {
  filename: string
  size_bytes: number
  modified_at: number
  partial: boolean
}

export interface ModelFilesResponse {
  files: ModelFile[]
  active_filename: string
  models_dir: string
  disk: { total_bytes: number | null; free_bytes: number | null }
  download: LlmDownloadState
}

export async function listLlmConfigs(): Promise<{ configs: LlmConfigRow[] }> {
  return apiFetch('/admin/llm-configs')
}

export async function createLlmConfig(input: LlmConfigInput): Promise<{ config: LlmConfigRow }> {
  return apiFetch('/admin/llm-configs', { method: 'POST', body: JSON.stringify(input) })
}

export async function updateLlmConfig(
  id: number,
  input: LlmConfigInput,
): Promise<{ config: LlmConfigRow }> {
  return apiFetch(`/admin/llm-configs/${id}`, { method: 'PUT', body: JSON.stringify(input) })
}

export async function deleteLlmConfig(id: number): Promise<{ deleted: number }> {
  return apiFetch(`/admin/llm-configs/${id}`, { method: 'DELETE' })
}

export async function activateLlmConfig(
  id: number,
): Promise<{ config: LlmConfigRow; reload: LlmReloadState }> {
  return apiFetch(`/admin/llm-configs/${id}/activate`, { method: 'POST' })
}

export async function resetLlmConfig(): Promise<{
  reload: LlmReloadState
  removed_file: boolean
}> {
  return apiFetch('/admin/llm-configs/reset', { method: 'POST' })
}

export async function getLlmStatus(): Promise<LlmStatus> {
  return apiFetch('/admin/llm-status')
}

export async function listLlmModelFiles(): Promise<ModelFilesResponse> {
  return apiFetch('/admin/llm-models/files')
}

export async function downloadLlmModel(req: {
  url: string
  filename?: string
  sha256?: string
  extra_urls?: string[]
}): Promise<{ download: LlmDownloadState }> {
  return apiFetch('/admin/llm-models/download', { method: 'POST', body: JSON.stringify(req) })
}

export async function getLlmDownloadStatus(): Promise<{ download: LlmDownloadState }> {
  return apiFetch('/admin/llm-models/download/status')
}

export async function cancelLlmDownload(): Promise<{
  cancelled: boolean
  download: LlmDownloadState
}> {
  return apiFetch('/admin/llm-models/download/cancel', { method: 'POST' })
}

export async function deleteLlmModelFile(filename: string): Promise<{ filename: string }> {
  return apiFetch(`/admin/llm-models/files/${encodeURIComponent(filename)}`, { method: 'DELETE' })
}
