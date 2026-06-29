import { getBuildInfo } from '../api/system'

export const CLIENT_BUILD = import.meta.env.VITE_APP_BUILD || 'dev'
export const APP_UPDATE_POLL_MS = 60_000

const STALE_CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Loading chunk [\w-]+ failed/i,
  /ChunkLoadError/i,
  /Unable to preload CSS/i,
  // Safari sometimes hides a failed module URL behind this DOMException.
  /The string did not match the expected pattern/i,
]

export function isStaleChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message))
}

interface UpdateMonitorOptions {
  clientBuild?: string
  pollMs?: number
  fetchBuild?: () => Promise<{ build: string }>
  reload?: () => void
}

/**
 * Detect a newly deployed application image while this tab is still open.
 * The build ID is compiled into the SPA and compared with the no-store server
 * endpoint. A mismatch means the API and current JavaScript no longer belong
 * to the same deployment, so a full reload is the only safe recovery.
 */
export function createAppUpdateMonitor(options: UpdateMonitorOptions = {}) {
  const clientBuild = options.clientBuild ?? CLIENT_BUILD
  const pollMs = options.pollMs ?? APP_UPDATE_POLL_MS
  const fetchBuild = options.fetchBuild ?? getBuildInfo
  const reload = options.reload ?? (() => window.location.reload())
  let intervalId: ReturnType<typeof setInterval> | undefined
  let checking = false
  let reloadTriggered = false

  async function check(): Promise<boolean> {
    if (checking || reloadTriggered || clientBuild === 'dev') return false
    checking = true
    try {
      const { build } = await fetchBuild()
      if (build && build !== 'dev' && build !== 'unbekannt' && build !== clientBuild) {
        reloadTriggered = true
        reload()
        return true
      }
      return false
    } catch {
      // A transient outage must not disturb the current page. The next poll,
      // focus, visibility or online event retries automatically.
      return false
    } finally {
      checking = false
    }
  }

  function checkWhenVisible(): void {
    if (document.visibilityState === 'visible') void check()
  }

  function start(): () => void {
    void check()
    intervalId = window.setInterval(() => void check(), pollMs)
    window.addEventListener('focus', checkWhenVisible)
    window.addEventListener('online', checkWhenVisible)
    document.addEventListener('visibilitychange', checkWhenVisible)
    return stop
  }

  function stop(): void {
    if (intervalId !== undefined) window.clearInterval(intervalId)
    intervalId = undefined
    window.removeEventListener('focus', checkWhenVisible)
    window.removeEventListener('online', checkWhenVisible)
    document.removeEventListener('visibilitychange', checkWhenVisible)
  }

  return { check, start, stop }
}

export function installAppUpdateMonitor(): () => void {
  return createAppUpdateMonitor().start()
}
