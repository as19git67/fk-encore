import { ref, watch, type Ref } from 'vue'
import type { Photo } from '../api/photos'
import type { ScreenOrientation } from '../composables/useScreenOrientation'
import { shouldSwitchSide } from '../utils/orientationVariants'

/**
 * The other side of the fullscreen photo (.claude/plans/orientierungs-varianten.md).
 *
 * A view that drives `FullscreenOverlay` keeps the shown photo in
 * `cursorPhoto`. This composable keeps its counterpart from the format group
 * next to it and owns the two ways of swapping them:
 *
 *   - `toggle()` — the user pressed the button or `R`. The choice is pinned:
 *     turning the device does not override it until the cursor moves on.
 *   - the screen turns — the overlay switches to the side that fits, unless
 *     pinned. That is the visible promise of the feature: turn the phone and
 *     the picture is suddenly the one shot that way.
 *
 * `reset()` belongs at the start of every hydration of a *new* index, so the
 * pin never outlives the photo it was made for.
 */
export function useVariantCursor(opts: {
  screen: Ref<ScreenOrientation>
  cursorPhoto: Ref<Photo | null>
}) {
  const variantPhoto = ref<Photo | null>(null)
  const pinned = ref(false)

  function swap() {
    const shown = opts.cursorPhoto.value
    const other = variantPhoto.value
    if (!shown || !other) return
    opts.cursorPhoto.value = other
    variantPhoto.value = shown
  }

  /** Forget the counterpart and the pin — the cursor moved to another photo. */
  function reset() {
    variantPhoto.value = null
    pinned.value = false
  }

  /** The counterpart for the current photo as the details batch delivered it. */
  function setCounterpart(photo: Photo | null) {
    variantPhoto.value = photo
  }

  /** User's choice: show the other side and keep it through rotations. */
  function toggle() {
    if (!variantPhoto.value) return
    swap()
    pinned.value = true
  }

  /** Switch to the side that fits the screen, if that is not the shown one. */
  function followScreen() {
    if (
      shouldSwitchSide({
        shown: opts.cursorPhoto.value?.orientation,
        counterpart: variantPhoto.value?.orientation,
        screen: opts.screen.value,
        pinned: pinned.value,
      })
    ) {
      swap()
    }
  }

  watch(opts.screen, followScreen)

  return { variantPhoto, pinned, reset, setCounterpart, toggle, followScreen }
}
