import { onMounted, onUnmounted } from 'vue'

export interface GalleryKeyboardOptions {
  /** Navigate to previous photo (←) */
  onLeft: () => void
  /** Navigate to next photo (→) */
  onRight: () => void
  /** Navigate up in the nav panel (↑) – always routed to nav panel */
  onUp: () => void
  /** Navigate down in the nav panel (↓) – always routed to nav panel */
  onDown: () => void
  /** Toggle fullscreen (Space) */
  onSpace: () => void
  /** Optional: extra key handler called after the above (e.g. F, X shortcuts) */
  onExtra?: (e: KeyboardEvent) => void
  /** Return true to block all handling (e.g. when a modal or date editor is open) */
  isBlocked?: () => boolean
}

/**
 * Central keyboard handler for the gallery views.
 *
 * Navigation contract (as agreed):
 *  ←  / →   → always navigate in the photo grid
 *  ↑  / ↓   → always navigate in the nav panel (TimelineNav or PersonNav)
 *  Space     → toggle fullscreen
 *
 * When no nav panel is present (e.g. AlbumDetailView), the caller can wire
 * onUp/onDown to section-jump logic within the grid.
 */
export function useGalleryKeyboard(options: GalleryKeyboardOptions) {
  function handleKeydown(e: KeyboardEvent) {
    // Skip when typing in an input/textarea
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return

    // Allow caller to block (e.g. during date editing, compare view)
    if (options.isBlocked?.()) return

    switch (e.key) {
      case 'ArrowLeft':
        options.onLeft()
        e.preventDefault()
        break
      case 'ArrowRight':
        options.onRight()
        e.preventDefault()
        break
      case 'ArrowUp':
        options.onUp()
        e.preventDefault()
        break
      case 'ArrowDown':
        options.onDown()
        e.preventDefault()
        break
      case ' ':
        options.onSpace()
        e.preventDefault()
        break
      default:
        options.onExtra?.(e)
    }
  }

  onMounted(() => window.addEventListener('keydown', handleKeydown))
  onUnmounted(() => window.removeEventListener('keydown', handleKeydown))
}
