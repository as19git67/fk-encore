import { ref, shallowRef, computed, watch } from 'vue'
import type { Ref } from 'vue'
import type { Photo } from '../api/photos'

/**
 * Manages single + multi photo selection state.
 * selectedIndex is the "primary" selected photo (used for keyboard nav & sidebar).
 * selectedPhotoIds is the full set (used for multi-select batch operations).
 *
 * shallowRef is used for selectedPhotoIds because we always replace the Set
 * rather than mutating it. This avoids Vue deep-reactivity proxy issues with
 * Set.has/size tracking and ensures computed properties update on assignment.
 */
export function usePhotoSelection(photos: Ref<Photo[]>) {
  const selectedIndex = ref(-1)
  const selectedPhotoIds = shallowRef<Set<number>>(new Set())

  const selectedPhoto = computed<Photo | null>(() => {
    if (selectedIndex.value < 0) return null
    return photos.value[selectedIndex.value] ?? null
  })

  const selectedPhotos = computed<Photo[]>(() => {
    if (selectedPhotoIds.value.size === 0) return []
    if (selectedPhotoIds.value.size === 1) {
      const id = Array.from(selectedPhotoIds.value)[0]!
      const photo = photos.value.find(p => p.id === id)
      return photo ? [photo] : []
    }
    return photos.value.filter(p => selectedPhotoIds.value.has(p.id))
  })

  // Keep selectedPhotoIds in sync when selectedIndex changes
  watch(selectedIndex, (newIdx) => {
    if (newIdx >= 0 && photos.value[newIdx]) {
      const photoId = photos.value[newIdx]!.id
      if (!selectedPhotoIds.value.has(photoId)) {
        selectedPhotoIds.value = new Set([photoId])
      }
    } else if (newIdx < 0) {
      selectedPhotoIds.value = new Set()
    }
  })

  function selectPhoto(index: number, event?: MouseEvent) {
    const photo = photos.value[index]
    if (!photo) return

    if (event?.shiftKey && !event.ctrlKey && !event.metaKey && selectedIndex.value !== -1) {
      // Range selection
      const start = Math.min(selectedIndex.value, index)
      const end = Math.max(selectedIndex.value, index)
      const newSet = new Set(selectedPhotoIds.value)
      for (let i = start; i <= end; i++) {
        const p = photos.value[i]
        if (p) newSet.add(p.id)
      }
      selectedPhotoIds.value = newSet
    } else if (event?.ctrlKey || event?.metaKey) {
      // Toggle individual photo
      const newSet = new Set(selectedPhotoIds.value)
      if (newSet.has(photo.id)) {
        newSet.delete(photo.id)
        if (selectedIndex.value === index) {
          if (newSet.size > 0) {
            const firstId = Array.from(newSet)[0]!
            selectedIndex.value = photos.value.findIndex(p => p.id === firstId)
          } else {
            selectedIndex.value = -1
          }
        }
      } else {
        newSet.add(photo.id)
        selectedIndex.value = index
      }
      selectedPhotoIds.value = newSet
    } else {
      // Single selection
      selectedIndex.value = index
      selectedPhotoIds.value = new Set([photo.id])
    }
  }

  function clearSelection() {
    selectedIndex.value = -1
    selectedPhotoIds.value = new Set()
  }

  return {
    selectedIndex,
    selectedPhotoIds,
    selectedPhoto,
    selectedPhotos,
    selectPhoto,
    clearSelection,
  }
}
