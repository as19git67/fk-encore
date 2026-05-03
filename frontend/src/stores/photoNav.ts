import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Shared photo navigation state across gallery, album, and persons views.
 *
 * Rules:
 * - `selectedPhotoId` is the single source of truth for "which photo the user
 *   last looked at". Views use this on mount to pre-select / scroll to a photo
 *   when no explicit ?photoId= deeplink is present.
 * - `scrollPositions` stores the last scroll offset per view key. These are
 *   cleared whenever the user actively changes the selected photo (click or
 *   keyboard) so the next view always scrolls the selected photo into view
 *   rather than restoring a now-stale position.
 * - When the user just scrolls (mouse / touch) without changing selection, the
 *   view saves its own position so coming back lands in the same spot.
 */
export const usePhotoNavStore = defineStore('photoNav', () => {
  const selectedPhotoId = ref<number | null>(null)
  // view key → scroll offset (px)
  const scrollPositions = ref<Record<string, number>>({})

  /** Called when the user actively selects a photo (click or arrow key). */
  function selectPhoto(id: number) {
    if (selectedPhotoId.value !== id) {
      selectedPhotoId.value = id
      // Clear saved scroll positions so every view scrolls to the new photo.
      scrollPositions.value = {}
    }
  }

  /** Save the current scroll position for a view without changing selection. */
  function saveScrollPosition(viewKey: string, pos: number) {
    scrollPositions.value[viewKey] = pos
  }

  /** Retrieve the saved scroll position for a view, or null if none. */
  function getScrollPosition(viewKey: string): number | null {
    return scrollPositions.value[viewKey] ?? null
  }

  return { selectedPhotoId, selectPhoto, saveScrollPosition, getScrollPosition }
})
