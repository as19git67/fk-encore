<script setup lang="ts">
/**
 * Virtualized grid of face-annotated photo thumbnails for a single person.
 *
 * Mirrors the architecture of VirtualGallery / VirtualAlbumGrid: TanStack
 * useVirtualizer virtualizes ROWS (not individual cells). Each rendered row is
 * a CSS grid containing `cols` photos, and the fixed square row height lets the
 * virtualizer compute the scroll area without measuring every thumbnail.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import Button from 'primevue/button'
import HeicImage from './HeicImage.vue'
import { type CurationStatus, type FaceBBox } from '../api/photos'
import { photoThumbnailSrc } from '../composables/useTransformedPhotosIndex'
import { useAuthStore } from '../stores/auth'
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

type VirtualRow = { key: string | number | bigint; index: number; start: number; size: number }

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

// ── Layout: column count + row height ─────────────────────────────────────────
// Keep the constants aligned with VirtualGallery / VirtualAlbumGrid so the
// person detail grid uses the same breakpoints and visual density.
const TARGET_CELL_MIN_PX = 140
const GAP_PX = 4

const auth = useAuthStore()
const cols = ref(3)
const cellSize = ref(TARGET_CELL_MIN_PX)
const rowHeight = computed(() => cellSize.value + GAP_PX)

const scrollRef = ref<HTMLElement | null>(null)
let resizeObs: ResizeObserver | null = null

function recalcLayout(width: number) {
  const totalGap = (n: number) => GAP_PX * Math.max(0, n - 1)
  let n = Math.max(1, Math.floor((width + GAP_PX) / (TARGET_CELL_MIN_PX + GAP_PX)))
  if (n < 1) n = 1
  const cell = Math.floor((width - totalGap(n)) / n)
  cols.value = n
  cellSize.value = cell
}

onMounted(() => {
  if (scrollRef.value) {
    const style = getComputedStyle(scrollRef.value)
    const hPad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    recalcLayout(scrollRef.value.clientWidth - hPad)
    resizeObs = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) recalcLayout(entry.contentRect.width)
    })
    resizeObs.observe(scrollRef.value)
  }
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
  if (renderRowsTimer) {
    clearTimeout(renderRowsTimer)
    renderRowsTimer = null
  }
})

// ── Virtualizer over rows ─────────────────────────────────────────────────────
const rowCount = computed(() => Math.ceil(props.items.length / Math.max(1, cols.value)))

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rowCount.value,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => rowHeight.value,
    overscan: 4,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems() as VirtualRow[])
const totalSize = computed(() => virtualizer.value.getTotalSize())

// The Virtualizer updates on every scroll tick. If we render those rows
// immediately, HeicImage mounts for every intermediate row during a long fling
// and starts thumbnail/render requests that the user never actually sees. Keep
// the virtual scroll geometry instant, but debounce which rows are committed to
// the DOM so only the settled viewport fetches thumbnails.
const renderedRows = ref<VirtualRow[]>([])
const RENDER_ROWS_DEBOUNCE_MS = 150
let renderRowsTimer: ReturnType<typeof setTimeout> | null = null

function commitRenderedRows(rows: VirtualRow[]) {
  renderedRows.value = rows.slice()
}

function scheduleRenderedRows(rows: VirtualRow[]) {
  if (renderedRows.value.length === 0) {
    commitRenderedRows(rows)
    return
  }
  if (renderRowsTimer) clearTimeout(renderRowsTimer)
  renderRowsTimer = setTimeout(() => {
    renderRowsTimer = null
    commitRenderedRows(virtualRows.value)
  }, RENDER_ROWS_DEBOUNCE_MS)
}

watch(virtualRows, scheduleRenderedRows, { flush: 'post' })

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

watch(() => [props.items, cols.value] as const, () => {
  // Items changed (filter or reload), or a resize changed the row mapping:
  // keep the selected photo visible in the virtualized viewport.
  scrollToItemIndex(props.selectedIndex, 'auto')
  commitRenderedRows(virtualRows.value)
})

// ── Helpers ──────────────────────────────────────────────────────────────────
function thumbnailSrc(item: FacePhotoItem): string {
  return photoThumbnailSrc({
    photoId: item.photo.id,
    filename: item.photo.filename,
    width: thumbnailSrcWidth(item.face.bbox),
    userId: auth.user?.id,
  })
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
        v-for="row in renderedRows"
        :key="String(row.key)"
        class="pg-row"
        :style="{
          transform: `translateY(${row.start}px)`,
          height: `${row.size}px`,
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
          :style="{ height: `${cellSize}px` }"
          @click="emit('update:selectedIndex', idx)"
          @dblclick="emit('open-fullscreen')"
        >
          <div class="photo-thumb">
            <HeicImage
              :src="thumbnailSrc(item)"
              :alt="item.photo.original_name"
              loading="lazy"
              objectFit="cover"
              :imageStyle="thumbnailImageStyle(item.face.bbox)"
            >
              <div class="face-box" :style="faceBoxStyle(item.face.bbox)" />
            </HeicImage>
          </div>

          <i v-if="item.photo.curation_status === 'favorite'" class="pi pi-heart-fill favorite-badge" />
          <i v-if="item.photo.curation_status === 'hidden'" class="pi pi-thumbs-down-fill hidden-badge" />

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
                :icon="item.photo.curation_status === 'hidden' ? 'pi pi-thumbs-down-fill' : 'pi pi-thumbs-down'"
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
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  contain: layout size style;
  scrollbar-gutter: stable;
  padding: 6px;
  box-sizing: border-box;
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
  column-gap: 4px;
  padding-bottom: 4px;
  box-sizing: border-box;
}

.photo-item {
  position: relative;
  border-radius: 4px;
  overflow: hidden;
  background: var(--p-content-background);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  cursor: pointer;
  transition: transform 0.2s;
  border: none;
  outline: none;
  contain: layout paint;
}

.photo-item:hover { transform: scale(1.02); }

.photo-item:focus-visible,
.photo-item.selected {
  outline: 3px solid var(--p-focus-ring-color);
  outline-offset: -3px;
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
