// User-specific slideshow interval (the gap between photos during the
// fullscreen slideshow). Stored per browser in localStorage; the control in
// the fullscreen toolbar cycles through a small set of step values.

const STORAGE_KEY = 'slideshow_interval_ms'

/** Selectable interval values, in ms (3, 5, 10, 15, 20, 30 seconds). */
export const SLIDESHOW_INTERVAL_OPTIONS_MS = [3000, 5000, 10000, 15000, 20000, 30000]

/** Default when the user hasn't chosen one yet. */
export const DEFAULT_SLIDESHOW_INTERVAL_MS = 5000

/**
 * Read the stored interval. Falls back to `fallback` (default 5 s) when nothing
 * is stored or the stored value isn't one of the offered options (e.g. a stale
 * value from an older build).
 */
export function loadSlideshowIntervalMs(
  fallback: number = DEFAULT_SLIDESHOW_INTERVAL_MS,
): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw == null) return fallback
    const n = Number(raw)
    return SLIDESHOW_INTERVAL_OPTIONS_MS.includes(n) ? n : fallback
  } catch {
    return fallback
  }
}

/** Persist the chosen interval (ignored if not one of the offered options). */
export function saveSlideshowIntervalMs(ms: number): void {
  if (!SLIDESHOW_INTERVAL_OPTIONS_MS.includes(ms)) return
  try {
    localStorage.setItem(STORAGE_KEY, String(ms))
  } catch {
    // ignore (private mode / storage disabled)
  }
}

/** Next value in the step cycle, wrapping around. Unknown values restart. */
export function nextSlideshowIntervalMs(current: number): number {
  const i = SLIDESHOW_INTERVAL_OPTIONS_MS.indexOf(current)
  const next = SLIDESHOW_INTERVAL_OPTIONS_MS[(i + 1) % SLIDESHOW_INTERVAL_OPTIONS_MS.length]
  return next ?? DEFAULT_SLIDESHOW_INTERVAL_MS
}

/** Compact label for the toolbar button, e.g. "5s". */
export function formatSlideshowIntervalLabel(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

// One-time hint: on touch devices the interval is chosen by long-pressing the
// play button (no visible caret), so we show a dismissible hint the first time.
const HINT_SEEN_KEY = 'slideshow_longpress_hint_seen'

/** True once the long-press hint has been shown (and thus shouldn't repeat). */
export function hasSeenSlideshowLongPressHint(): boolean {
  try {
    return localStorage.getItem(HINT_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Remember that the long-press hint has been shown. */
export function markSlideshowLongPressHintSeen(): void {
  try {
    localStorage.setItem(HINT_SEEN_KEY, '1')
  } catch {
    // ignore (private mode / storage disabled)
  }
}
