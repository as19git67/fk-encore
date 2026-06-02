// Pure decision logic for the fullscreen slideshow (auto-advance), extracted
// from FullscreenOverlay.vue so it can be unit-tested without a DOM. The
// component owns the timer and the `playing` ref; these helpers only decide
// *whether* the timer should be armed and *when* playback should stop.

export interface SlideshowState {
  /** The user has started the slideshow via the play button. */
  playing: boolean
  /** Configured interval between photos, in ms. <= 0 disables the slideshow. */
  autoAdvanceMs: number
  /** A photo exists after the current one. */
  hasNext: boolean
  /** The transform editor overlay is open (reading/editing — pause). */
  editorOpen: boolean
  /** The details flyout is active (reading — pause). */
  detailsActive: boolean
  /** The current photo has finished loading/decoding. */
  currentLoaded: boolean
}

/**
 * While playing, the slideshow stops once there is no next photo — it never
 * wraps around. Callers use this to flip the button back to "play".
 */
export function slideshowReachedEnd(s: Pick<SlideshowState, 'playing' | 'hasNext'>): boolean {
  return s.playing && !s.hasNext
}

/**
 * Whether the auto-advance timer should be (re)armed right now. The slideshow
 * runs only while the user started it, an interval is configured, there's a
 * next photo, nothing is being read/edited on top, and the current photo has
 * finished loading.
 */
export function shouldArmSlideshow(s: SlideshowState): boolean {
  return (
    s.playing &&
    s.autoAdvanceMs > 0 &&
    s.hasNext &&
    !s.editorOpen &&
    !s.detailsActive &&
    s.currentLoaded
  )
}

/**
 * Whether moving from one photo to another crosses a day boundary that should
 * be announced (e.g. the day-change banner). The very first photo the overlay
 * opens on has no previous day key, so it is never treated as a change.
 */
export function isDayChange(prevDayKey: string | null, nextDayKey: string): boolean {
  return prevDayKey !== null && nextDayKey !== prevDayKey
}

/**
 * Whether the slideshow description caption should be shown: only while the
 * slideshow is running, not while the details split-view is open (the
 * description is already in the sidebar there), and only when the photo has a
 * non-empty description.
 */
export function shouldShowCaption(
  playing: boolean,
  splitView: boolean,
  description: string | null | undefined,
): boolean {
  return playing && !splitView && (description ?? '').trim().length > 0
}
