import { apiFetch } from './client'

export interface RunToolOptions {
  dry_run?: boolean
  batch?: number
  sample?: number
  tax_sample?: number
  focus_sections?: string
  focus_categories?: string
}

export interface ToolStatus {
  tool: string
  running: boolean
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
