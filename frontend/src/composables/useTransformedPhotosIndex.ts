// Single-fetch index of "which photos has the calling user edited".
//
// The gallery / album grids use this to decide per tile whether to
// route through /photos/:id/render?v=user&user=… (so the thumbnail
// reflects the user's crop + colour recipe) or the bare
// /photos/file/<filename>?w=… (when there is no recipe).
//
// One Set is enough for the whole app: it's shared across components
// via module-level state. Loaded lazily on first access; the editor's
// save / delete handlers patch it in-place via markPhotoTransformed
// so newly-edited tiles flip to the rendered URL immediately, without
// waiting for the next page load.

import { ref, computed } from 'vue'
import { getMyTransformedPhotoIds, getRenderedPhotoUrl } from '../api/photoTransforms'
import { getPhotoUrl } from '../api/photos'

const photoIds = ref<Set<number> | null>(null)
let loadPromise: Promise<void> | null = null

function load(): Promise<void> {
  if (photoIds.value) return Promise.resolve()
  if (!loadPromise) {
    loadPromise = getMyTransformedPhotoIds()
      .then((res) => {
        photoIds.value = new Set(res.photo_ids)
      })
      .catch(() => {
        // If we can't load, treat as "nobody has transforms". The
        // tiles will fall back to the original thumbnails — strictly
        // worse than ideal but never wrong.
        photoIds.value = new Set()
      })
      .finally(() => {
        loadPromise = null
      })
  }
  return loadPromise
}

/**
 * Patch the in-memory set in response to an editor save / delete.
 * Called from PhotoTransformEditor.vue right alongside the existing
 * invalidateUserTransform(photoId) call, so the gallery picks up the
 * change immediately.
 */
export function markPhotoTransformed(photoId: number, hasTransform: boolean) {
  if (!photoIds.value) {
    // Not yet loaded — kick off the fetch; once it lands the patched
    // value will already be reflected by the source of truth on the
    // server. The mark is a no-op until then.
    load()
    return
  }
  if (hasTransform) photoIds.value.add(photoId)
  else photoIds.value.delete(photoId)
}

export function useTransformedPhotosIndex() {
  load()
  return {
    has(photoId: number): boolean {
      return photoIds.value?.has(photoId) ?? false
    },
    isReady: computed(() => photoIds.value !== null),
  }
}

/**
 * Pick the right thumbnail URL for a photo, taking the user's saved
 * recipe into account. When the calling user has edited this photo,
 * the URL routes through /photos/:id/render?v=user — otherwise the
 * fast /photos/file/<filename> path. Shared by every grid in the app
 * (gallery, album covers, person covers, recap, compare view) so a
 * once-edited photo never reverts to the original in any surface.
 */
export function photoThumbnailSrc(args: {
  photoId: number | undefined | null
  filename: string
  width?: number
  userId: number | undefined | null
}): string {
  const { photoId, filename, width, userId } = args
  if (photoId && userId && photoIds.value?.has(photoId)) {
    return getRenderedPhotoUrl(photoId, {
      variant: 'user',
      userId,
      width,
    })
  }
  return getPhotoUrl(filename, width)
}
