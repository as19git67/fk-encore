/**
 * Whether hover tooltips should be enabled for this device.
 *
 * iOS Safari (and touch devices in general) treat the first tap on an element
 * that has a hover tooltip as a *hover*: it shows the tooltip and swallows the
 * click, so the button only fires on the second or third tap. On devices whose
 * primary pointer cannot hover precisely we therefore skip tooltips entirely
 * (the directive is registered as a no-op), so the very first tap clicks.
 *
 * `(hover: hover) and (pointer: fine)` is true for a mouse/trackpad (desktop,
 * touch-laptop with a trackpad) and false for a phone/tablet touchscreen.
 */
export const TOOLTIP_CAPABLE_QUERY = '(hover: hover) and (pointer: fine)'

export function deviceSupportsHoverTooltips(
  match?: (query: string) => boolean,
): boolean {
  const fn =
    match ??
    ((q: string) =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(q).matches
        : true) // assume desktop when matchMedia is unavailable
  return fn(TOOLTIP_CAPABLE_QUERY)
}
