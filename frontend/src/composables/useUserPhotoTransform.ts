// Per-photo client-side recipe display.
//
// Fetches the calling user's transform for a photo (if any) and exposes
// ready-to-bind CSS + SVG markup the consumer can apply to an <img>.
// A small in-memory cache keeps repeated views of the same photo
// (gallery → flyout → next photo → back) from re-fetching.
//
// Crop is intentionally NOT applied here — the existing HeicImage
// component owns layout and adding crop math through it is invasive.
// For now this composable applies only the colour recipe (exposure,
// contrast, gamma, BP/WP). The full crop preview lives in the editor
// (PhotoTransformEditor with its own <img>) and in the server-rendered
// /photos/:id/render?v=user variant.

import { computed, ref, watch, type Ref } from 'vue'
import { API_BASE_URL } from '../api/client'
import { getPhotoTransforms, type PhotoTransformRow } from '../api/photoTransforms'
import {
  buildRecipeSvgFilter,
  recipeToCssFilter,
  type PhotoTransformRecipe,
} from '../utils/photoTransformRecipe'

const cache = new Map<number, PhotoTransformRow | null>()
const inFlight = new Map<number, Promise<PhotoTransformRow | null>>()

/**
 * Reactive version counter bumped on every invalidate. Active
 * useUserPhotoTransform() instances watch this in addition to their
 * own photoId — so editor save / delete / adopt invalidations trigger
 * the FullscreenOverlay / Sidebar to refetch the recipe and re-render
 * the visible image without needing a manual reload.
 */
const cacheVersion = ref(0)

/**
 * Drop the cached transform for a photo. Call this from any code path
 * that mutates the recipe — Save / Delete / Adopt in the editor — so the
 * gallery / flyout pick up the new state on next view.
 */
export function invalidateUserTransform(photoId: number) {
  cache.delete(photoId)
  inFlight.delete(photoId)
  cacheVersion.value++
}

/**
 * Reactive lookup of the caller's recipe for a photo. Returns:
 *   recipe — the raw transform row (null while loading or absent)
 *   cssFilter — value for the `filter` CSS property (empty if neutral)
 *   svgFilterId / svgFilterMarkup — the off-screen <filter> def to embed
 *     once per photo when the recipe needs gamma / BP / WP
 */
export function useUserPhotoTransform(photoIdRef: Ref<number | null | undefined>) {
  const recipe = ref<PhotoTransformRow | null>(null)

  async function load(id: number) {
    if (cache.has(id)) {
      recipe.value = cache.get(id) ?? null
      return
    }
    let promise = inFlight.get(id)
    if (!promise) {
      promise = getPhotoTransforms(id)
        .then((b) => b.mine)
        .catch(() => null)
      inFlight.set(id, promise)
    }
    const row = await promise
    cache.set(id, row)
    inFlight.delete(id)
    if (photoIdRef.value === id) recipe.value = row
  }

  // Re-load when either the watched photo or the global cacheVersion
  // changes. The version channel is how the editor's save / delete
  // invalidations propagate into all currently-active consumers — the
  // visible photo refreshes without a route change.
  watch(
    [photoIdRef, cacheVersion],
    ([id]) => {
      if (!id) {
        recipe.value = null
        return
      }
      load(id)
    },
    { immediate: true },
  )

  const recipeShape = computed<PhotoTransformRecipe>(() => {
    const r = recipe.value
    if (!r) return {}
    return {
      // crop intentionally omitted — see file header.
      rotation: r.rotation,
      exposure: r.exposure,
      contrast: r.contrast,
      gamma: r.gamma,
      white_point: r.white_point,
      black_point: r.black_point,
    }
  })

  const svgFilterId = computed(() =>
    photoIdRef.value ? `photo-recipe-display-${photoIdRef.value}` : undefined,
  )
  const svgFilterMarkup = computed(() =>
    svgFilterId.value ? buildRecipeSvgFilter(svgFilterId.value, recipeShape.value) : '',
  )
  const cssFilter = computed(() =>
    recipeToCssFilter(recipeShape.value, svgFilterId.value),
  )

  /**
   * Server-rendered URL for the photo with the current user's recipe
   * applied. Returns null when there is no recipe (callers should fall
   * back to the original /photos/file/* URL).
   *
   * Cache-busted by the recipe's updated_at so the browser fetches the
   * new image on every edit. The server's cache key doesn't depend on
   * `t`, so server-side caching stays effective across users / sessions
   * with the same recipe.
   */
  function buildRenderedUrl(width?: number): string | null {
    const r = recipe.value
    const id = photoIdRef.value
    if (!r || !id) return null
    const params = new URLSearchParams({
      v: 'user',
      user: String(r.user_id),
    })
    if (width) params.set('w', String(width))
    if (r.updated_at) params.set('t', r.updated_at)
    return `${API_BASE_URL}/photos/${id}/render?${params.toString()}`
  }

  return {
    recipe,
    recipeShape,
    cssFilter,
    svgFilterId,
    svgFilterMarkup,
    buildRenderedUrl,
  }
}
