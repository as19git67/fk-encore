<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { usePhotoLazyLoad } from '../composables/usePhotoLazyLoad'
import { getPhotoUrl, type CurationStatus, type FaceBBox } from '../api/photos'
import { thumbnailImageStyle, faceBoxStyle, thumbnailSrcWidth } from '../utils/faceBbox'

// ── Types ─────────────────────────────────────────────────────────────────────
export interface FaceItem {
  id: number
  bbox?: FaceBBox | null
  ignored?: boolean
}

export interface FacePhotoItem {
  face: FaceItem
  photo: {
    id: number
    filename: string
    original_name: string
    curation_status: CurationStatus
  }
}

const props = defineProps<{
  items: FacePhotoItem[]
  selectedIndex: number
  loadingDetails?: boolean
  canDelete?: boolean
}>()

const emit = defineEmits<{
  'update:selectedIndex': [index: number]
  'open-fullscreen': []
  'toggle-favorite': [id: number, status: CurationStatus]
  'hide': [id: number]
  'restore': [id: number]
}>()

// ── Lazy loading ──────────────────────────────────────────────────────────────
const scrollRef = ref<HTMLElement | null>(null)
const { visiblePhotoIds, setupObserver } = usePhotoLazyLoad('200px')

function scrollToSelected(behavior: ScrollBehavior = 'auto') {
  const idx = props.selectedIndex
  if (idx < 0 || !scrollRef.value) return
  const item = props.items[idx]
  if (!item) return
  const el = scrollRef.value.querySelector(`[data-photo-id="${item.photo.id}"]`)
  el?.scrollIntoView({ behavior, block: 'nearest' })
}

watch(scrollRef, (el) => { if (el) nextTick(() => setupObserver(el)) })

watch(() => props.items, async () => {
  await nextTick()
  if (scrollRef.value) {
    setupObserver(scrollRef.value)
    // Scroll to the (possibly restored) selection once items have rendered.
    scrollToSelected('auto')
  }
})

watch(() => props.selectedIndex, () => nextTick(() => scrollToSelected('smooth')))

onMounted(() => {
  if (scrollRef.value) {
    setupObserver(scrollRef.value)
    nextTick(() => scrollToSelected('auto'))
  }
})

// ── Face bbox helpers (extracted to utils/faceBbox.ts) ────────────────────────
function thumbnailSrc(filename: string, bbox: FaceBBox | undefined | null): string {
  return getPhotoUrl(filename, thumbnailSrcWidth(bbox))
}
</script>

<template>
  <div class="photo-grid-scroll" ref="scrollRef">
    <div v-if="loadingDetails" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Lade…
    </div>
    <div v-else-if="items.length === 0" class="info-text">Keine Fotos.</div>
    <div v-else class="photo-grid">
      <div
        v-for="(item, idx) in items"
        :key="item.photo.id"
        :data-photo-id="item.photo.id"
        class="photo-item"
        tabindex="0"
        :class="{
          selected: idx === selectedIndex,
          'is-hidden': item.photo.curation_status === 'hidden',
          'is-favorite': item.photo.curation_status === 'favorite',
        }"
        @click="emit('update:selectedIndex', idx)"
        @dblclick="emit('open-fullscreen')"
      >
        <div class="photo-thumb">
          <HeicImage
            v-if="visiblePhotoIds.has(item.photo.id)"
            :src="thumbnailSrc(item.photo.filename, item.face.bbox)"
            :alt="item.photo.original_name"
            objectFit="cover"
            :imageStyle="thumbnailImageStyle(item.face.bbox)"
          >
            <div class="face-box" :style="faceBoxStyle(item.face.bbox)" />
          </HeicImage>
        </div>

        <i v-if="item.photo.curation_status === 'favorite'" class="pi pi-heart-fill favorite-badge" />
        <i v-if="item.photo.curation_status === 'hidden'" class="pi pi-eye-slash hidden-badge" />

        <div v-if="visiblePhotoIds.has(item.photo.id)" class="photo-info">
          <span class="name">{{ item.photo.original_name }}</span>
          <div class="photo-actions">
            <Button
              v-if="canDelete"
              size="small"
              :icon="item.photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              :severity="item.photo.curation_status === 'favorite' ? 'warn' : 'secondary'"
              text rounded
              @click.stop="emit('toggle-favorite', item.photo.id, item.photo.curation_status)"
            />
            <Button
              v-if="canDelete"
              size="small"
              :icon="item.photo.curation_status === 'hidden' ? 'pi pi-eye-slash' : 'pi pi-eye'"
              :severity="item.photo.curation_status === 'hidden' ? 'danger' : 'secondary'"
              text rounded
              @click.stop="item.photo.curation_status === 'hidden' ? emit('restore', item.photo.id) : emit('hide', item.photo.id)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.photo-grid-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 1rem;
}

.info-text {
  display: flex;
  justify-content: center;
  gap: 0.5em;
  padding: 3rem 1rem;
  color: var(--p-text-muted-color);
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--grid-min-col), 1fr));
  gap: var(--grid-gap);
}

.photo-item {
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--p-content-background);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  cursor: pointer;
  transition: transform 0.2s;
  border: 4px solid transparent;
  outline: none;
}

.photo-item:hover { transform: scale(1.02); }

.photo-item:focus-visible {
  outline: 2px solid var(--p-primary-300);
  outline-offset: -2px;
}

.photo-item.selected {
  border-color: var(--p-primary-color);
  transform: scale(1.05);
  box-shadow: 0 0 15px var(--p-primary-color);
  z-index: 10;
}

.photo-thumb {
  width: 100%;
  height: 200px;
  background: var(--p-content-hover-background);
  overflow: hidden;
}

.photo-thumb :deep(.heic-image-container) { width: 100%; height: 100%; }

.photo-info {
  padding: 0.25rem 0.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(0,0,0,0.65);
  backdrop-filter: blur(4px);
  position: absolute;
  bottom: 0; left: 0; right: 0;
  opacity: 0;
  transition: opacity 0.2s;
}

.photo-item:hover .photo-info,
.photo-item.selected .photo-info,
.photo-item:focus-within .photo-info { opacity: 1; }

.photo-info .name {
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  color: white;
}

.photo-actions { display: flex; gap: 0; }

.photo-item.is-hidden { opacity: 0.35; }
.photo-item.is-hidden:hover { opacity: 0.7; }
.photo-item.is-favorite { border-color: var(--p-yellow-500); }

.favorite-badge, .hidden-badge {
  position: absolute;
  top: 8px; right: 8px;
  font-size: 1.2rem;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
  z-index: 5;
}
.favorite-badge { color: var(--p-yellow-500); }
.hidden-badge { color: white; }

/* ── Face bbox overlay ───────────────────────────────────────────────────── */
.face-box {
  position: absolute;
  border: 2px solid var(--p-yellow-500, #eab308);
  box-sizing: border-box;
  pointer-events: none;
  z-index: 2;
  border-radius: 2px;
}
</style>
