import { apiFetch } from './client'

export type JobStatus =
  | 'scheduled'
  | 'running'
  | 'ok'
  | 'error'
  | 'deactivated'
  | 'paused'

export interface ScheduledJob {
  name: string
  description: string | null
  service: string | null
  schedule_label: string | null
  status: JobStatus
  enabled: boolean
  next_fire_at: string | null
  last_run_at: string | null
  last_duration_ms: number | null
  last_error: string | null
  run_count: number
  error_count: number
}

export async function listScheduledJobs(): Promise<{ jobs: ScheduledJob[] }> {
  return apiFetch('/admin/scheduled-jobs')
}

export async function pauseScheduledJob(name: string): Promise<{ job: ScheduledJob }> {
  return apiFetch(`/admin/scheduled-jobs/${encodeURIComponent(name)}/pause`, { method: 'POST' })
}

export async function resumeScheduledJob(name: string): Promise<{ job: ScheduledJob }> {
  return apiFetch(`/admin/scheduled-jobs/${encodeURIComponent(name)}/resume`, { method: 'POST' })
}

export async function runScheduledJobNow(name: string): Promise<{ job: ScheduledJob }> {
  return apiFetch(`/admin/scheduled-jobs/${encodeURIComponent(name)}/run-now`, { method: 'POST' })
}
