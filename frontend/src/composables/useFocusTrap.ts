import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

/**
 * Keeps the keyboard inside an overlay while it is open (issue #1281).
 *
 * PrimeVue's `Dialog` does this for itself. The app also has surfaces that
 * are dialogs in everything but name — the recap detail, the fullscreen
 * photo, the mobile sheets — built as a plain `<div>` over the page. Opening
 * one left the focus wherever it was, usually far behind the backdrop, so a
 * keyboard user could not reach the thing that had just appeared and Tab
 * walked the page underneath instead.
 *
 * Three obligations, which together are what a modal owes the keyboard:
 *
 *   1. On open, focus moves into the overlay. The first focusable element
 *      unless the caller names a better one — a viewer wants its close
 *      button, a form its first field.
 *   2. Tab and Shift+Tab cycle within it. At the last element Tab returns to
 *      the first, and the other way round.
 *   3. On close, focus returns to whatever opened it, so the reader is put
 *      back where they were rather than at the top of the page.
 *
 * `Escape` is handled here too, since a surface that traps the keyboard has
 * to offer a way out that does not need the mouse.
 */

/**
 * What counts as reachable by Tab. `[tabindex="-1"]` is deliberately absent:
 * such an element can be focused by script (the container itself, when there
 * is nothing inside) but is not part of the cycle.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface FocusTrapOptions {
  /** Called on Escape. Leave it out for a surface that closes some other way. */
  onEscape?: () => void
  /**
   * The element to start on. Defaults to the first focusable one, which is
   * right for a form and wrong for a viewer whose first control is "next".
   */
  initialFocus?: () => HTMLElement | null
}

/**
 * Everything inside `root` that Tab can reach, in document order.
 *
 * Hidden elements are left out: a `display: none` control still matches the
 * selector, and focusing one puts the caret nowhere the reader can see.
 * `getClientRects()` is the cheap test that covers `display: none`,
 * `hidden`, and an ancestor of either.
 */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  )
}

export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  options: FocusTrapOptions = {},
): void {
  /** Who had the focus before the overlay opened, to give it back. */
  let previouslyFocused: HTMLElement | null = null

  function onKeydown(event: KeyboardEvent) {
    if (!active.value) return
    const root = container.value
    if (!root) return

    if (event.key === 'Escape') {
      if (!options.onEscape) return
      event.preventDefault()
      event.stopPropagation()
      options.onEscape()
      return
    }

    if (event.key !== 'Tab') return
    const focusable = focusableWithin(root)
    if (focusable.length === 0) {
      // Nothing to move to, so Tab must not take the reader out of the
      // overlay and behind the backdrop.
      event.preventDefault()
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const current = document.activeElement

    // Focus outside the overlay at all (a click on the backdrop, a stray
    // programmatic focus) is brought back to the edge Tab was heading for.
    if (!(current instanceof HTMLElement) || !root.contains(current)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
      return
    }
    if (event.shiftKey && current === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  async function enter() {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The overlay is rendered by the same change that switched `active`, so
    // it is not in the DOM yet when this watcher runs.
    await nextTick()
    const root = container.value
    if (!root) return
    const target = options.initialFocus?.() ?? focusableWithin(root)[0] ?? root
    target.focus()
  }

  function leave() {
    const previous = previouslyFocused
    previouslyFocused = null
    // Only if it is still on the page — a row that the overlay deleted, or a
    // list that has since reloaded, cannot take the focus back.
    if (previous && previous.isConnected) previous.focus()
  }

  watch(active, (isActive, wasActive) => {
    if (isActive) void enter()
    else if (wasActive) leave()
  })

  // Most of these overlays are `v-if`-ed by their parent, so the component
  // mounts already open and the watcher above never fires — it only reacts
  // to a change. Without this the fullscreen viewer opened with the focus
  // still on the thumbnail behind it.
  onMounted(() => {
    if (active.value) void enter()
  })

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeydown, true)
    onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))
  }
}
