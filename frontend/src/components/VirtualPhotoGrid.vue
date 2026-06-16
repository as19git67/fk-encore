<script setup lang="ts">
/**
 * Virtualized grid for an in-memory list of photos.
 *
 * Mirrors the row-virtualization architecture of `VirtualGallery` /
 * `VirtualAlbumGrid` (TanStack `useVirtualizer` over ROWS, fixed row height
 * = square cell + gap), but the data source is a plain `Photo[]` the parent
 * already holds — no server pagination, no `useGallerySource`. Used by the
 * public/shared album view, which loads the whole album up front.
 *
 * Column count is orientation-aware on phones (per product requirement):
 *   - phone portrait  → 3 columns
 *   - phone landscape → 5 columns
 *   - tablet / desktop → width-driven (~200px target cell, matches the
 *     `--grid-min-col` gallery thumbnail width).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import HeicImage from './HeicImage.vue'
import { getPhotoUrl, type Photo } from '../api/photos'

const props = defineProps<{
  photos: Photo[]
}>()

const emit = defineEmits<{
  open: [photo: Photo]
}>()

// ── Layout: column count + cell size ────────────────────────────────────────
const GAP_PX = 4
/** Phones (short side ≤ this) get the fixed 3 (portrait) / 5 (landscape)
 *  column layout; larger devices fall back to the width-driven count. */
const PHONE_MAX_SHORT_SIDE = 540
/** Target cell width for tablets / desktop — matches `--grid-min-col`. */
const TARGET_CELL_MIN_PX = 200

const cols = ref(3)
const cellSize = ref(TARGET_CELL_MIN_PX)

const rowHeight = computed(() => cellSize.value + GAP_PX)

const scrollRef = ref<HTMLElement | null>(null)
let resizeObs: ResizeObserver | null = null

function targetCols(width: number): number {
  const shortSide = Math.min(window.innerWidth, window.innerHeight)
  if (shortSide <= PHONE_MAX_SHORT_SIDE) {
    const portrait = window.innerHeight >= window.innerWidth
    return portrait ? 3 : 5
  }
  return Math.max(1, Math.floor((width + GAP_PX) / (TARGET_CELL_MIN_PX + GAP_PX)))
}

function recalcLayout(width: number) {
  if (width <= 0) return
  const n = targetCols(width)
  const totalGap = GAP_PX * Math.max(0, n - 1)
  cols.value = n
  cellSize.value = Math.floor((width - totalGap) / n)
}

function measure() {
  const el = scrollRef.value
  if (!el) return
  const style = getComputedStyle(el)
  const hPad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  recalcLayout(el.clientWidth - hPad)
}

onMounted(() => {
  if (scrollRef.value) {
    measure()
    resizeObs = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) recalcLayout(entry.contentRect.width)
    })
    resizeObs.observe(scrollRef.value)
  }
  // Orientation flips change innerHeight/innerWidth without always producing
  // a distinct container-width event (e.g. square-ish tablets), so recompute
  // explicitly to pick up the portrait/landscape column switch on phones.
  window.addEventListener('orientationchange', measure)
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
  window.removeEventListener('orientationchange', measure)
})

// ── Virtualizer over rows ────────────────────────────────────────────────────
const rowCount = computed(() => Math.ceil(props.photos.length / Math.max(1, cols.value)))

const virtualizer = useVirtualizer(
  computed(() => {
    // Read `rowHeight` here so it becomes a dependency of this computed.
    // Otherwise the options only re-evaluate when `rowCount` changes — and on
    // a phone the portrait column count (3) equals the initial default, so a
    // portrait load changes only the cell size, not `rowCount`. Without this
    // the virtualizer would keep its initial row-height estimate and space the
    // rows far too tall (landscape works by chance: cols 3 → 5 bumps rowCount).
    const estimatedRowHeight = rowHeight.value
    return {
      count: rowCount.value,
      getScrollElement: () => scrollRef.value,
      estimateSize: () => estimatedRowHeight,
      overscan: 4,
    }
  }),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

function rowPhotos(rowIndex: number): Photo[] {
  const start = rowIndex * cols.value
  const end = Math.min(start + cols.value, props.photos.length)
  return props.photos.slice(start, end)
}
</script>

<template>
  <div ref="scrollRef" class="vpg">
    <div class="vpg__inner" :style="{ height: `${totalSize}px` }">
      <div
        v-for="row in virtualRows"
        :key="String(row.key)"
        class="vpg__row"
        :style="{
          transform: `translateY(${row.start}px)`,
          height: `${rowHeight}px`,
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
        }"
      >
        <div
          v-for="photo in rowPhotos(row.index)"
          :key="photo.id"
          class="vpg__item"
          @click="emit('open', photo)"
        >
          <HeicImage
            :src="getPhotoUrl(photo.filename, 400)"
            :alt="photo.original_name"
            objectFit="cover"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vpg {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  contain: layout size style;
  scrollbar-gutter: stable;
  padding: var(--grid-gap-compact);
  box-sizing: border-box;
}

.vpg__inner {
  position: relative;
  width: 100%;
}

.vpg__row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  column-gap: var(--grid-gap-compact);
  padding-bottom: var(--grid-gap-compact);
  box-sizing: border-box;
}

.vpg__item {
  position: relative;
  height: 100%;
  overflow: hidden;
  cursor: pointer;
  border-radius: var(--radius-sm);
  background: var(--p-content-hover-background, #eee);
}

.vpg__item :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}

@media (hover: hover) {
  .vpg__item:hover {
    opacity: 0.85;
  }
}
</style>
