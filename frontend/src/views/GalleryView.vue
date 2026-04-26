<script setup lang="ts">
/**
 * Greenfield virtualized photo gallery — Phase 1 (thumbnails only).
 *
 * Deliberately minimal. The view's only jobs are:
 *   - decide which photo to land on (query param > localStorage > newest)
 *   - mount <VirtualGallery>
 *   - persist the last-tapped photo id to localStorage so the next visit
 *     can land on it
 *
 * No filter, sort, search, fullscreen, detail sidebar, curation, upload,
 * stack-compare, or selection. Those will plug in around the same
 * <VirtualGallery> in later phases.
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import VirtualGallery from '../components/VirtualGallery.vue'
import type { GalleryGridEntry } from '../api/gallery'

// Reuse the legacy view's localStorage key so users keep their
// last-selected position across both gallery implementations during the
// transition period.
const LAST_PHOTO_KEY = 'photos_last_selected_id'

const route = useRoute()
const router = useRouter()

/**
 * The initial photo to land on. Resolved once at mount time:
 *   1. ?photoId=… from the URL (deep link)
 *   2. localStorage[LAST_PHOTO_KEY] (last visit)
 *   3. null → VirtualGallery defaults to the last (newest in ASC) page
 */
const initialPhotoId = computed<number | null>(() => {
  const q = Number(route.query.photoId)
  if (Number.isFinite(q) && q > 0) return q
  const s = Number(localStorage.getItem(LAST_PHOTO_KEY))
  if (Number.isFinite(s) && s > 0) return s
  return null
})

// Capture the initial value into a non-reactive const so changes to the
// query string after mount do not retrigger a full reload from inside
// VirtualGallery — Phase 1 has no UI to change filters/sort, so the
// initial anchor is the only one we ever need.
const initialAnchor = ref<number | null>(initialPhotoId.value)

// Strip ?photoId from the URL so a refresh (or navigation back) lands on
// the *current* selection rather than the deep-link target indefinitely.
if (route.query.photoId !== undefined) {
  void router.replace({ query: { ...route.query, photoId: undefined } })
}

function onPhotoClick(entry: GalleryGridEntry) {
  // Phase 1: just remember it for next visit. Fullscreen / detail open
  // here in a later phase.
  try {
    localStorage.setItem(LAST_PHOTO_KEY, String(entry.id))
  } catch { /* storage might be disabled — fail silently */ }
}
</script>

<template>
  <div class="gallery-view">
    <VirtualGallery
      :around-photo-id="initialAnchor"
      @photo-click="onPhotoClick"
    />
  </div>
</template>

<style scoped>
.gallery-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow: hidden;
}
</style>
