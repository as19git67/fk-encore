import { apiFetch } from './client'

export type JobStatus = 'scheduled' | 'running' | 'ok' | 'error' | 'deactivated'

export interface ScheduledJob {
  name: string
  description: string | null
  service: string | null
  schedule_label: string | null
  status: JobStatus
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
