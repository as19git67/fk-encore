/**
 * Selector for the interactive controls layered over the fullscreen photo:
 * toolbar (`.fs-topbar`), bottom action bar (`.fs-actions-bar`), the stack
 * badge, the details flyout, and any plain button / link / form field.
 *
 * Taps and gestures that start on these must NOT be hijacked by the photo's
 * swipe/zoom touch handling — in particular the content-level `touchmove`
 * preventDefault(), which otherwise cancels the synthetic click and makes the
 * toolbar buttons require a second or third tap (most visibly in landscape,
 * where the bars sit over the photo pane).
 */
export const FULLSCREEN_INTERACTIVE_SELECTOR =
  'button, a, input, textarea, .fs-stack-badge, .fs-details-flyout, .fs-topbar, .fs-actions-bar'

export function isFullscreenInteractiveTarget(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest(FULLSCREEN_INTERACTIVE_SELECTOR) !== null
}

/**
 * Selector for just the toolbar layers (top bar + bottom action bar) — NOT the
 * details flyout or the photo.
 *
 * Used to decide which taps must NOT restart the slideshow countdown: tapping a
 * toolbar action that operates on the current photo (details toggle, favorite,
 * hide) should let the slideshow keep running uninterrupted. A tap inside the
 * open details flyout (e.g. typing a comment) is deliberately excluded so the
 * countdown still resets there and the slideshow doesn't advance while typing.
 * (Editing pauses the slideshow via its own mechanism.)
 */
export const FULLSCREEN_TOOLBAR_SELECTOR = '.fs-topbar, .fs-actions-bar'

export function isFullscreenToolbarTarget(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest(FULLSCREEN_TOOLBAR_SELECTOR) !== null
}
