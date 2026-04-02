<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { usePhotoLazyLoad } from '../composables/usePhotoLazyLoad'
import { getPhotoUrl, type CurationStatus, type FaceBBox } from '../api/photos'

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

watch(scrollRef, (el) => { if (el) nextTick(() => setupObserver(el)) })

watch(() => props.items, async () => {
  await nextTick()
  if (scrollRef.value) setupObserver(scrollRef.value)
})

onMounted(() => {
  if (scrollRef.value) setupObserver(scrollRef.value)
})

// ── Face bbox helpers ─────────────────────────────────────────────────────────
function validBbox(bbox: FaceBBox | undefined | null): FaceBBox | null {
  if (!bbox) return null
  if (bbox.x > 1.1 || bbox.y > 1.1) return null
  return bbox
}

function thumbnailZoom(bbox: FaceBBox | undefined | null): number {
  const b = validBbox(bbox)
  if (!b) return 1
  return Math.min(4, Math.max(1.5, 0.4 / Math.max(b.width, b.height)))
}

function thumbnailImageStyle(bbox: FaceBBox | undefined | null): Record<string, string> {
  const b = validBbox(bbox)
  if (!b) return {}
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const zoom = thumbnailZoom(bbox)
  return {
    objectPosition: `${(cx * 100).toFixed(1)}% ${(cy * 100).toFixed(1)}%`,
    transform: `scale(${zoom.toFixed(2)}) translate(${((0.5 - cx) * 100).toFixed(1)}%, ${((0.5 - cy) * 100).toFixed(1)}%)`,
    transformOrigin: '50% 50%',
  }
}

function faceBoxStyle(bbox: FaceBBox | undefined | null): Record<string, string> {
  const b = validBbox(bbox)
  if (!b) return { display: 'none' }
  return {
    left: `${(b.x * 100).toFixed(2)}%`,
    top: `${(b.y * 100).toFixed(2)}%`,
    width: `${(b.width * 100).toFixed(2)}%`,
    height: `${(b.height * 100).toFixed(2)}%`,
  }
}

function thumbnailSrc(filename: string, bbox: FaceBBox | undefined | null): string {
  const zoom = thumbnailZoom(bbox)
  const width = zoom >= 2 ? 800 : zoom >= 1.5 ? 600 : 400
  return getPhotoUrl(filename, width)
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

        <div class="photo-info">
          <span class="name">{{ item.photo.original_name }}</span>
          <div class="photo-actions">
            <Button
              v-if="canDelete && item.photo.curation_status === 'hidden'"
              size="small" icon="pi pi-eye" severity="info" text rounded
              @click.stop="emit('restore', item.photo.id)"
            />
            <Button
              v-if="canDelete && item.photo.curation_status !== 'hidden'"
              size="small"
              :icon="item.photo.curation_status === 'favorite' ? 'pi pi-heart-fill' : 'pi pi-heart'"
              :severity="item.photo.curation_status === 'favorite' ? 'warn' : 'secondary'"
              text rounded
              @click.stop="emit('toggle-favorite', item.photo.id, item.photo.curation_status)"
            />
            <Button
              v-if="canDelete && item.photo.curation_status !== 'hidden'"
              size="small" icon="pi pi-eye-slash" severity="danger" text rounded
              @click.stop="emit('hide', item.photo.id)"
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
  color: var(--text-color-secondary);
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.photo-item {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  background: var(--surface-card);
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
  background: var(--surface-ground);
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
  border: 2px solid #eab308;
  box-sizing: border-box;
  pointer-events: none;
  z-index: 2;
  border-radius: 2px;
}
</style>
