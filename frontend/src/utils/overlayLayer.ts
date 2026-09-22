/**
 * What is open *on top of* the page right now.
 *
 * Escape belongs to the topmost layer. A list in select mode listens for it
 * on the document, and so does every hand-built overlay with a focus trap —
 * but a dialog, a popup menu or a dropdown that opened later is above both of
 * them, and the key is meant for that one alone. Without this, closing the
 * sort menu with Escape also left select mode and dropped the selection, and
 * Tab inside a dialog opened from a trapped sheet was yanked back into the
 * sheet (issue #1281, review follow-up).
 *
 * PrimeVue teleports its overlays to `<body>`, so `container.contains(target)`
 * cannot recognise them: they are outside the surface they logically belong
 * to. Their class names are what gives them away.
 *
 * Only markers that exist exclusively while an overlay is open are listed.
 * `[role="menu"]` and `[role="listbox"]` are deliberately absent: an inline
 * `<Menu>` or listbox carries them all the time, and a page holding one would
 * swallow Escape forever.
 */
const OVERLAY_SELECTOR = [
  // Hand-built overlays (the recap detail, the photo compare view) say so
  // themselves; `useFocusTrap` asks its callers for exactly this.
  '[role="dialog"]',
  '[role="alertdialog"]',
  // PrimeVue, whose overlays only exist in the DOM while they are open.
  '.p-dialog',
  '.p-confirmdialog',
  '.p-drawer',
  '.p-menu-overlay',
  '.p-tieredmenu-overlay',
  '.p-contextmenu',
  '.p-popover',
  '.p-select-overlay',
  '.p-multiselect-overlay',
  '.p-autocomplete-overlay',
  '.p-datepicker-panel',
].join(',')

/**
 * The overlay an event came out of, if any.
 *
 * `root` is the surface asking — its own overlay does not count as being
 * above itself, and neither does anything inside it.
 */
export function overlayAbove(target: EventTarget | null, root?: Element | null): Element | null {
  if (!(target instanceof Element)) return null
  if (root && root.contains(target)) return null
  const overlay = target.closest(OVERLAY_SELECTOR)
  if (!overlay) return null
  if (root && root.contains(overlay)) return null
  return overlay
}

/**
 * Whether any overlay is open at all.
 *
 * The coarser of the two tests, and the one that catches a popup menu opened
 * by mouse: PrimeVue only moves the focus into such a menu when it was opened
 * from the keyboard, so an Escape meant for it is reported against whatever
 * still holds the focus — a button in the toolbar underneath.
 */
export function hasOpenOverlay(root: ParentNode = document): boolean {
  return root.querySelector(OVERLAY_SELECTOR) !== null
}
