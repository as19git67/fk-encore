import { API_BASE_URL, apiFetch } from './client'

export interface RunToolOptions {
  dry_run?: boolean
  batch?: number
  sample?: number
  tax_sample?: number
  focus_sections?: string
  focus_categories?: string
  /** scoreboard only: the name this measurement is filed under. */
  label?: string
  /** scoreboard only: an earlier label to compare the new measurement against. */
  compare_with?: string
}

export interface ToolStatus {
  tool: string
  running: boolean
}

export interface ReportFile {
  name: string
  size: number
}

export async function runTool(
  tool: string,
  options?: RunToolOptions,
): Promise<{ status: string }> {
  return apiFetch(`/admin/tools/run/${encodeURIComponent(tool)}`, {
    method: 'POST',
    body: options ? JSON.stringify(options) : undefined,
  })
}

export async function cancelTool(
  tool: string,
): Promise<{ status: string }> {
  return apiFetch(`/admin/tools/cancel/${encodeURIComponent(tool)}`, {
    method: 'POST',
  })
}

export async function getToolsStatus(): Promise<{ tools: ToolStatus[] }> {
  return apiFetch('/admin/tools/status')
}

export async function listReports(
  tool: string,
): Promise<{ files: ReportFile[] }> {
  return apiFetch(`/admin/tools/reports/${encodeURIComponent(tool)}`)
}

export async function downloadReport(tool: string, filename: string): Promise<void> {
  const token = localStorage.getItem('auth_token')
  const url = `${API_BASE_URL}/admin/tools/reports/${encodeURIComponent(tool)}/${encodeURIComponent(filename)}`
  const resp = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)
  const blob = await resp.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
