<script setup lang="ts">
/**
 * Virtualised grid of face-annotated photo thumbnails for a single person.
 *
 * Mirrors the architecture of VirtualAlbumGrid / PersonsGrid: TanStack
 * useVirtualizer virtualises ROWS with a fixed CELL_HEIGHT so the browser
 * only mounts cells inside (or near) the viewport.
 *
 * The face bounding-box overlay and curation badges stay on every visible
 * cell; since only viewport cells are in the DOM the IntersectionObserver
 * lazy-load trick is no longer needed — images are mounted only when their
 * row is virtual-visible.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
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

// ── Layout ───────────────────────────────────────────────────────────────────
const TARGET_CELL_MIN_PX = 140
const GAP_PX = 4
const CELL_HEIGHT = 200

const cols = ref(3)
const cellSize = ref(TARGET_CELL_MIN_PX)
const rowHeight = computed(() => CELL_HEIGHT + GAP_PX)

const scrollRef = ref<HTMLElement | null>(null)
let resizeObs: ResizeObserver | null = null

function recalcLayout(width: number) {
  const totalGap = (n: number) => GAP_PX * Math.max(0, n - 1)
  const n = Math.max(1, Math.floor((width + GAP_PX) / (TARGET_CELL_MIN_PX + GAP_PX)))
  cols.value = n
  cellSize.value = Math.floor((width - totalGap(n)) / n)
}

onMounted(() => {
  if (scrollRef.value) {
    recalcLayout(scrollRef.value.clientWidth)
    resizeObs = new ResizeObserver((entries) => {
      const e = entries[0]
      if (e) recalcLayout(e.contentRect.width)
    })
    resizeObs.observe(scrollRef.value)
  }
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
})

// ── Virtualizer ──────────────────────────────────────────────────────────────
const rowCount = computed(() => Math.ceil(props.items.length / Math.max(1, cols.value)))

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rowCount.value,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => rowHeight.value,
    overscan: 4,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

function rowItems(rowIndex: number): { item: FacePhotoItem; idx: number }[] {
  const start = rowIndex * cols.value
  const end = Math.min(start + cols.value, props.items.length)
  return props.items.slice(start, end).map((item, i) => ({ item, idx: start + i }))
}

// ── Scroll to selected ───────────────────────────────────────────────────────
function scrollToItemIndex(idx: number, align: 'center' | 'auto' = 'auto') {
  if (idx < 0 || idx >= props.items.length || cols.value <= 0) return
  virtualizer.value.scrollToIndex(Math.floor(idx / cols.value), { align })
}

watch(() => props.selectedIndex, (idx) => scrollToItemIndex(idx, 'auto'))

watch(() => props.items, async () => {
  // Items changed (filter or reload): ensure the selected photo stays visible.
  scrollToItemIndex(props.selectedIndex, 'auto')
})

// ── Helpers ──────────────────────────────────────────────────────────────────
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

    <div v-else class="pg-inner" :style="{ height: `${totalSize}px` }">
      <div
        v-for="row in virtualRows"
        :key="String(row.key)"
        class="pg-row"
        :style="{
          transform: `translateY(${row.start}px)`,
          height: `${CELL_HEIGHT}px`,
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
        }"
      >
        <div
          v-for="{ item, idx } in rowItems(row.index)"
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
  </div>
</template>

<style scoped>
.photo-grid-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  contain: strict;
  padding: 0;
}

.info-text {
  display: flex;
  justify-content: center;
  gap: 0.5em;
  padding: 3rem 1rem;
  color: var(--p-text-muted-color);
}

.pg-inner {
  position: relative;
  width: 100%;
}

.pg-row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  gap: 4px;
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
  height: 100%;
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
  height: 100%;
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

.photo-actions { display: flex; gap: 0; }

.photo-item.is-hidden { opacity: 0.35; }
.photo-item.is-hidden:hover { opacity: 0.7; }

.favorite-badge, .hidden-badge {
  position: absolute;
  top: 8px; right: 8px;
  font-size: 1.2rem;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
  z-index: 5;
}
.favorite-badge { color: var(--p-yellow-400, #facc15); }
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
