export const FEED_FULLSCREEN_MIN_ZOOM = 1
export const FEED_FULLSCREEN_MAX_ZOOM = 5
export const FEED_FULLSCREEN_TAP_SLOP = 10

export function clampFeedZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return FEED_FULLSCREEN_MIN_ZOOM
  return Math.min(FEED_FULLSCREEN_MAX_ZOOM, Math.max(FEED_FULLSCREEN_MIN_ZOOM, zoom))
}

export function feedPinchZoom(
  startZoom: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (startDistance <= 0 || currentDistance <= 0) return clampFeedZoom(startZoom)
  return clampFeedZoom(startZoom * (currentDistance / startDistance))
}

export function isFeedFullscreenTap(dx: number, dy: number, pinched: boolean): boolean {
  return !pinched && Math.hypot(dx, dy) < FEED_FULLSCREEN_TAP_SLOP
}

export function shouldUseNativeFeedFullscreen(
  matches: (query: string) => boolean = (query) => window.matchMedia(query).matches,
): boolean {
  return matches('(hover: hover) and (pointer: fine)')
}
