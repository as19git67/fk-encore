<script setup lang="ts">
/**
 * Virtualized photo gallery grid.
 *
 * Architecture:
 *   - The data source is a sparse array `entries` of length `total`
 *     (`useGallerySource`). The component never iterates this array; it
 *     only reads slots inside the rendered rows.
 *   - TanStack `useVirtualizer` virtualizes ROWS (not items). A row holds
 *     `cols` photos; layout inside the row is a plain CSS grid. Row height
 *     is fixed (cell + gap) so the virtualizer can compute the total
 *     scroll height as `rowCount * rowHeight` without measuring.
 *   - As soon as a row becomes visible, the component asks the source to
 *     `ensureRange(rowStart, rowEnd)` — the source fires page fetches for
 *     any unloaded slots that overlap the visible window.
 *   - Slots that are still `null` render as a skeleton tile (just an
 *     empty box) so the grid layout stays stable while the page loads.
 *
 * Phase 1 deliberately omits filter, sort, search, fullscreen, selection,
 * curation actions and stack-compare. The grid emits `photo-click` so the
 * outer view can plug them in later.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { getThumbUrl, type GalleryGridEntry } from '../api/gallery'
import { useGallerySource, GALLERY_PAGE_SIZE } from '../composables/useGallerySource'

const props = defineProps<{
  /** Photo to land on initially. Null = land on the last (newest in ASC) page. */
  aroundPhotoId?: number | null
}>()

const emit = defineEmits<{
  /** Fires when the user taps a photo. Phase 1: parent only logs / stores. */
  'photo-click': [entry: GalleryGridEntry]
}>()

// ── Data source ─────────────────────────────────────────────────────────────
const source = useGallerySource()
const { entries, total, initialLoading, error } = source

// ── Layout: column count + row height ───────────────────────────────────────
// Tracking column count here (rather than via CSS auto-fill) is the only
// way to pre-compute row heights for the virtualizer — auto-fill would
// shift items per row at every resize boundary, breaking absolute scroll
// math. Column count is derived from the container width and a target
// minimum cell size; matches the look-and-feel of the legacy grid.
const TARGET_CELL_MIN_PX = 140
const GAP_PX = 4
const cols = ref(3)
const cellSize = ref(140)
const rowHeight = computed(() => cellSize.value + GAP_PX)

const scrollRef = ref<HTMLElement | null>(null)
let resizeObs: ResizeObserver | null = null

function recalcLayout(width: number) {
  // Fit as many `TARGET_CELL_MIN_PX` cells as possible, then expand each
  // cell so the row exactly fills the container (gaps between cells but
  // no padding on the outside).
  const totalGap = (n: number) => GAP_PX * Math.max(0, n - 1)
  let n = Math.max(1, Math.floor((width + GAP_PX) / (TARGET_CELL_MIN_PX + GAP_PX)))
  if (n < 1) n = 1
  const cell = Math.floor((width - totalGap(n)) / n)
  cols.value = n
  cellSize.value = cell
}

onMounted(() => {
  if (scrollRef.value) {
    recalcLayout(scrollRef.value.clientWidth)
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
  source.cancel()
})

// ── Row count drives the virtualizer ────────────────────────────────────────
const rowCount = computed(() => Math.ceil((total.value ?? 0) / cols.value))

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rowCount.value,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => rowHeight.value,
    // Render a couple of rows above/below the viewport so scroll is smooth
    // and prefetch of the next page kicks in slightly before the user
    // sees the empty tiles.
    overscan: 4,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

/**
 * Pull the photo entries for one virtual row out of the sparse `entries`
 * array. Slots not yet loaded come back as `null` and the template renders
 * them as skeleton tiles.
 */
function rowSlots(rowIndex: number): (GalleryGridEntry | null)[] {
  const start = rowIndex * cols.value
  const end = Math.min(start + cols.value, total.value ?? 0)
  if (start >= end) return []
  // Read directly from the shallow ref; no map/filter, just a slice.
  return entries.value.slice(start, end)
}

// ── Edge prefetch ───────────────────────────────────────────────────────────
// Whenever the rendered virtual rows change, ask the source to make sure
// every overlapped slot is in flight. Pages already requested are deduped
// inside the source.
watch(virtualRows, (rows) => {
  if (rows.length === 0 || total.value === 0) return
  const firstIdx = rows[0]!.index * cols.value
  const lastIdx = (rows[rows.length - 1]!.index + 1) * cols.value
  // Pad the requested range a little so we prefetch the next page before
  // it scrolls into view. One PAGE_SIZE worth of look-ahead matches the
  // overscan rows above.
  source.ensureRange(
    Math.max(0, firstIdx - GALLERY_PAGE_SIZE),
    Math.min(total.value, lastIdx + GALLERY_PAGE_SIZE),
  )
}, { flush: 'post' })

// ── Initial load ────────────────────────────────────────────────────────────
const ready = ref(false)

async function startInitialLoad() {
  const { initialOffset } = await source.init({
    aroundPhotoId: props.aroundPhotoId ?? null,
    sortBy: 'taken_at',
    sortDir: 'asc',
  })
  ready.value = true
  // Scroll the virtualizer to the row containing the initial photo. Done
  // after the next frame so the virtualizer has measured the container.
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (cols.value > 0) {
    const targetRow = Math.floor(initialOffset / cols.value)
    virtualizer.value.scrollToIndex(targetRow, { align: 'center' })
  }
}

onMounted(() => {
  // Wait one frame so the ResizeObserver can run once and we have a real
  // column count before we ask the server for a window.
  requestAnimationFrame(() => { void startInitialLoad() })
})

// ── Click handling ──────────────────────────────────────────────────────────
function onTap(entry: GalleryGridEntry | null) {
  if (!entry) return
  emit('photo-click', entry)
}
</script>

<template>
  <div class="virtual-gallery" ref="scrollRef">
    <div v-if="initialLoading && !ready" class="vg-state vg-state--loading">
      Lade Fotos…
    </div>
    <div v-else-if="error" class="vg-state vg-state--error">{{ error }}</div>
    <div v-else-if="ready && total === 0" class="vg-state">
      Keine Fotos vorhanden.
    </div>

    <!-- Virtual scroll spacer: total height = total rows * rowHeight -->
    <div
      v-if="ready && total > 0"
      class="vg-inner"
      :style="{ height: `${totalSize}px` }"
    >
      <div
        v-for="row in virtualRows"
        :key="String(row.key)"
        class="vg-row"
        :style="{
          transform: `translateY(${row.start}px)`,
          height: `${row.size}px`,
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
        }"
      >
        <template v-for="(slot, i) in rowSlots(row.index)" :key="i">
          <button
            v-if="slot"
            class="vg-cell"
            :class="{
              'vg-cell--favorite': slot.curation === 'favorite',
              'vg-cell--hidden': slot.curation === 'hidden',
              'vg-cell--stack': !!slot.group,
              'vg-cell--stack-cover': slot.group?.is_cover,
            }"
            :style="{ height: `${cellSize}px` }"
            @click="onTap(slot)"
          >
            <img
              :src="getThumbUrl(slot.filename, 400)"
              :alt="''"
              loading="lazy"
              decoding="async"
              :style="slot.auto_crop
                ? { objectPosition: `${slot.auto_crop.x * 100}% ${slot.auto_crop.y * 100}%` }
                : undefined"
              class="vg-thumb"
            />
            <span v-if="slot.group?.is_cover" class="vg-stack-badge">
              {{ slot.group.member_count }}
            </span>
            <i
              v-if="slot.curation === 'favorite'"
              class="pi pi-heart-fill vg-favorite-icon"
            />
            <i
              v-if="slot.curation === 'hidden'"
              class="pi pi-eye-slash vg-hidden-icon"
            />
          </button>
          <div
            v-else
            class="vg-cell vg-cell--skeleton"
            :style="{ height: `${cellSize}px` }"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-gallery {
  position: relative;
  height: 100%;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--p-content-background, #fff);
  /* Native scroll on iOS (smooth + momentum). */
  -webkit-overflow-scrolling: touch;
}

.vg-state {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color, #6b7280);
  font-size: 0.95rem;
}

.vg-state--error {
  color: var(--p-red-500, #ef4444);
}

.vg-inner {
  position: relative;
  width: 100%;
}

.vg-row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  gap: 4px;
  padding: 0;
}

.vg-cell {
  position: relative;
  display: block;
  width: 100%;
  border: none;
  padding: 0;
  margin: 0;
  background: var(--p-content-hover-background, #f3f4f6);
  cursor: pointer;
  border-radius: 4px;
  overflow: hidden;
  /* Avoid layout shift while the image decodes. */
  contain: layout paint;
  /* Eliminate native button focus ring on touch devices. */
  -webkit-tap-highlight-color: transparent;
}

.vg-cell--skeleton {
  cursor: default;
  /* Subtle pulse so empty tiles look like loading state, not broken. */
  animation: vg-skeleton-pulse 1.4s ease-in-out infinite;
}

@keyframes vg-skeleton-pulse {
  0%, 100% { opacity: 0.6; }
  50%      { opacity: 1; }
}

.vg-thumb {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* Prevent UA from rendering a broken-image icon while decoding. */
  background: var(--p-content-hover-background, #f3f4f6);
}

/* Curation styling */
.vg-cell--favorite {
  outline: 2px solid var(--p-yellow-400, #facc15);
  outline-offset: -2px;
}

.vg-cell--hidden .vg-thumb {
  opacity: 0.55;
  filter: grayscale(0.4);
}

.vg-favorite-icon,
.vg-hidden-icon {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 0.85rem;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

.vg-hidden-icon {
  color: rgba(255, 255, 255, 0.85);
}

/* Stack styling — every group member gets a thin border so the user can
   see they belong to a stack; only the cover gets the count badge. */
.vg-cell--stack {
  outline: 2px solid var(--p-primary-300, #93c5fd);
  outline-offset: -2px;
}

.vg-cell--stack.vg-cell--stack-cover {
  outline-color: var(--p-primary-500, #3b82f6);
}

.vg-stack-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 999px;
  pointer-events: none;
}
</style>
