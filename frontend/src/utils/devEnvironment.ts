import { ref } from 'vue'
import { apiFetch } from '../api/client'
import { DEV_TITLE_PREFIX, markDevTitle } from '../components/layout/pageLayout'

/**
 * Whether the app runs in the dev stack on a copy of production
 * (documentation/plans/dev-system.md), from `GET /environment`. App.vue loads
 * it once and shows the thin "Dev" bar; every page title gets "Dev · ".
 */
export interface DevEnvironment {
  dev: boolean
  copy: { snapshot: string; date: string | null; refreshed_at: string | null } | null
  outbound: Record<string, 'off' | 'redirect' | 'on'>
}

export const devEnvironment = ref<DevEnvironment | null>(null)

/** "Dev · Kopie vom 14.11.2026" — or without a date when the copy is unknown. */
export function devBarText(env: DevEnvironment): string {
  const date = env.copy?.date
  if (!date) return `${DEV_TITLE_PREFIX} · Kopie von Prod`
  const [y, m, d] = date.split('-')
  return `${DEV_TITLE_PREFIX} · Kopie vom ${d}.${m}.${y}`
}

export async function loadDevEnvironment(): Promise<DevEnvironment | null> {
  try {
    const env = await apiFetch<DevEnvironment>('/environment')
    devEnvironment.value = env
    markDevTitle(env.dev)
    if (env.dev && typeof document !== 'undefined' && !document.title.startsWith(`${DEV_TITLE_PREFIX} · `)) {
      document.title = `${DEV_TITLE_PREFIX} · ${document.title}`
    }
    return env
  } catch {
    // An older server without the endpoint is prod.
    return null
  }
}
