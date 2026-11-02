import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { FeedAlbumItem, FeedPhotoItem, PhotoFeedCursor } from '../api/photoFeed'

/**
 * Caches the content feed's loaded items, pagination cursor and scroll
 * position so navigating into a photo's album and back returns the user to
 * exactly where they were — without re-fetching from page 1 (which would
 * lose their place in an infinite-scroll list).
 *
 * The card reserves each image's box at its real aspect ratio, so the
 * restored list has a stable height and the saved scroll offset lands on the
 * same card even before images finish loading.
 */
export const usePhotoFeedStore = defineStore('photoFeed', () => {
  const items = ref<FeedPhotoItem[]>([])
  const albums = ref<FeedAlbumItem[]>([])
  const nextCursor = ref<PhotoFeedCursor | null>(null)
  const scrollY = ref(0)
  const hasCache = ref(false)

  function save(snapshot: {
    items: FeedPhotoItem[]
    albums: FeedAlbumItem[]
    nextCursor: PhotoFeedCursor | null
    scrollY: number
  }) {
    items.value = snapshot.items
    albums.value = snapshot.albums
    nextCursor.value = snapshot.nextCursor
    scrollY.value = snapshot.scrollY
    hasCache.value = true
  }

  function clear() {
    items.value = []
    albums.value = []
    nextCursor.value = null
    scrollY.value = 0
    hasCache.value = false
  }

  return { items, albums, nextCursor, scrollY, hasCache, save, clear }
})
