import { defineStore } from 'pinia'
import { ref } from 'vue'
import { LAST_FOCUSED_ALBUM_KEY } from '../utils/albumsViewState'

/**
 * Shared photo navigation state across gallery, album, and persons views.
 *
 * Rules:
 * - `selectedPhotoId` is THE single source of truth for "which photo the user
 *   last focused". It is persisted to localStorage so it survives refreshes.
 *   Every view uses it on mount to select / scroll the photo into view (unless
 *   an explicit ?photoId= deeplink opens a photo straight in fullscreen).
 *   There is exactly one writer — `selectPhoto` — and the per-view "last photo"
 *   caches that used to shadow it have been removed.
 * - `selectedAlbumId` mirrors the same idea for albums — initialized from
 *   localStorage on first use so it survives page refreshes.
 * - `scrollPositions` stores the last scroll offset per view key. These are
 *   cleared whenever the user actively changes the selected photo (click or
 *   keyboard) so the next view always scrolls the selected photo into view
 *   rather than restoring a now-stale position.
 * - When the user just scrolls (mouse / touch) without changing selection, the
 *   view saves its own position so coming back lands in the same spot.
 */

const LAST_FOCUSED_PHOTO_KEY = 'last_focused_photo_id'

function readStoredAlbumId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_FOCUSED_ALBUM_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch { return null }
}

function readStoredPhotoId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_FOCUSED_PHOTO_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch { return null }
}

export const usePhotoNavStore = defineStore('photoNav', () => {
  /** The single "last focused photo" id. Survives page refresh. */
  const selectedPhotoId = ref<number | null>(readStoredPhotoId())
  // view key → scroll offset (px)
  const scrollPositions = ref<Record<string, number>>({})

  /** Which album the currently selected photo was chosen from (if any). Survives page refresh. */
  const selectedAlbumId = ref<number | null>(readStoredAlbumId())

  /**
   * One-time flag: when true, AlbumsView should auto-navigate into the
   * remembered album instead of just highlighting it in the list.
   * Set when the user selects a photo inside an album; consumed (reset to
   * false) the first time AlbumsView mounts and acts on it.
   */
  const jumpIntoAlbum = ref<boolean>(false)

  /** Called when the user actively focuses a photo (click, arrow key, fullscreen). */
  function selectPhoto(id: number) {
    if (selectedPhotoId.value !== id) {
      selectedPhotoId.value = id
      // Clear saved scroll positions so every view scrolls to the new photo.
      scrollPositions.value = {}
    }
    try { localStorage.setItem(LAST_FOCUSED_PHOTO_KEY, String(id)) } catch { /* storage off */ }
  }

  /**
   * Called when the user selects a photo inside an album grid.
   * Records both the photo and the album, and arms the one-shot
   * jumpIntoAlbum flag so AlbumsView auto-opens the album on next visit.
   */
  function selectPhotoInAlbum(photoId: number, albumId: number) {
    selectPhoto(photoId)
    if (selectedAlbumId.value !== albumId) {
      selectedAlbumId.value = albumId
      try { localStorage.setItem(LAST_FOCUSED_ALBUM_KEY, String(albumId)) } catch { /* storage off */ }
    }
    jumpIntoAlbum.value = true
  }

  /**
   * Reads and resets the jumpIntoAlbum flag atomically.
   * Returns true only once after selectPhotoInAlbum was called.
   */
  function consumeAlbumJump(): boolean {
    const val = jumpIntoAlbum.value
    jumpIntoAlbum.value = false
    return val
  }

  /** Save the current scroll position for a view without changing selection. */
  function saveScrollPosition(viewKey: string, pos: number) {
    scrollPositions.value[viewKey] = pos
  }

  /** Retrieve the saved scroll position for a view, or null if none. */
  function getScrollPosition(viewKey: string): number | null {
    return scrollPositions.value[viewKey] ?? null
  }

  return {
    selectedPhotoId,
    selectedAlbumId,
    selectPhoto,
    selectPhotoInAlbum,
    consumeAlbumJump,
    saveScrollPosition,
    getScrollPosition,
  }
})
