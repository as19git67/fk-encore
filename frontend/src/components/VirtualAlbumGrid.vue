<script setup lang="ts">
/**
 * Virtualized grid of album cards.
 *
 * Mirrors the architecture of `VirtualGallery`: TanStack `useVirtualizer`
 * virtualizes ROWS (not items). Each row is a CSS grid that holds `cols`
 * cards; row height is fixed (square cell + gap) so the virtualizer can
 * compute total scroll height as `rowCount * rowHeight` without measuring.
 *
 * Unlike `VirtualGallery`, the data source is the in-memory `albums` array
 * the parent already loaded — no server pagination or `useGallerySource`
 * coupling. The component just renders whatever slice of that array
 * intersects the viewport.
 *
 * Layout matches the gallery thumbnail grid:
 *   - desktop: 200px-min cells with 16px gap (== --grid-min-col / --grid-gap)
 *   - mobile (< 768): 120px-min cells with 4px gap (== --grid-gap-compact)
 *
 * Public API (defineExpose):
 *   - `scrollToAlbum(id, opts)` — scroll the row containing album `id` into
 *     view. With `opts.highlight = true`, the card briefly gets a
 *     `:focus-visible`-style ring so the user can spot which album they
 *     came back to from the detail view.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import HeicImage from './HeicImage.vue'
import { type Album, getPhotoUrl } from '../api/photos'

const props = defineProps<{
  albums: Album[]
  rememberedAlbumId?: number | null
}>()

const emit = defineEmits<{
  open: [album: Album]
}>()

// ── Layout: column count + cell size ────────────────────────────────────────
// Constants match VirtualGallery so the album list and the photo gallery
// render the same number of columns at every viewport width.
const TARGET_CELL_MIN_PX = 140
const GAP_PX = 4

const cols = ref(1)
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
  if (restoredClearTimer) { clearTimeout(restoredClearTimer); restoredClearTimer = null }
})

// ── Virtualizer over rows ────────────────────────────────────────────────────
const rowCount = computed(() => Math.ceil(props.albums.length / Math.max(1, cols.value)))

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

function rowAlbums(rowIndex: number): Album[] {
  const start = rowIndex * cols.value
  const end = Math.min(start + cols.value, props.albums.length)
  return props.albums.slice(start, end)
}

// ── Restored-focus highlight ─────────────────────────────────────────────────
// A programmatic scroll-to doesn't trigger :focus-visible, so the user
// wouldn't be able to spot "which one was I in?" without an explicit hint.
// Mark the remembered album for ~2.5s after restore, then fade.
const restoredFocusId = ref<number | null>(null)
let restoredClearTimer: ReturnType<typeof setTimeout> | null = null

function highlightAlbum(id: number) {
  restoredFocusId.value = id
  if (restoredClearTimer) clearTimeout(restoredClearTimer)
  restoredClearTimer = setTimeout(() => {
    restoredFocusId.value = null
    restoredClearTimer = null
  }, 2500)
}

// ── Arrow-key navigation ─────────────────────────────────────────────────────
function handleContainerKeydown(e: KeyboardEvent) {
  const focused = scrollRef.value?.querySelector<HTMLElement>('[data-album-id]:focus')
  if (!focused) return
  const id = Number(focused.dataset.albumId)
  const idx = props.albums.findIndex(a => a.id === id)
  if (idx < 0) return

  let nextIdx: number
  if (e.key === 'ArrowRight') nextIdx = Math.min(idx + 1, props.albums.length - 1)
  else if (e.key === 'ArrowLeft') nextIdx = Math.max(idx - 1, 0)
  else if (e.key === 'ArrowDown') nextIdx = Math.min(idx + cols.value, props.albums.length - 1)
  else if (e.key === 'ArrowUp') nextIdx = Math.max(idx - cols.value, 0)
  else return

  e.preventDefault()
  if (nextIdx === idx) return
  const targetAlbum = props.albums[nextIdx]
  if (!targetAlbum) return
  scrollToAlbum(targetAlbum.id, { focus: true })
}

// ── Public API ───────────────────────────────────────────────────────────────
function scrollToAlbum(id: number, opts: { highlight?: boolean; focus?: boolean } = {}): boolean {
  if (cols.value <= 0 || props.albums.length === 0) return false
  const idx = props.albums.findIndex(a => a.id === id)
  if (idx < 0) return false
  const row = Math.floor(idx / cols.value)
  virtualizer.value.scrollToIndex(row, { align: 'center' })
  if (opts.highlight) highlightAlbum(id)
  if (opts.focus) {
    // Wait one frame for Vue/virtualizer to render the newly-visible row,
    // then focus the card so keyboard navigation works immediately.
    requestAnimationFrame(() => {
      const card = scrollRef.value?.querySelector<HTMLElement>(`[data-album-id="${id}"]`)
      card?.focus({ preventScroll: true })
    })
  }
  return true
}

/**
 * Bring the parent-provided `rememberedAlbumId` back into view, or scroll
 * to the top if it's not in the current visible set. The parent calls
 * this after filter / sort / search changes — `useVirtualizer` keeps its
 * scroll offset in absolute pixels, so a shrunk-then-restored list would
 * otherwise leave the user clamped at the top of the new layout.
 */
async function rescrollToRemembered(opts: { highlight?: boolean } = {}) {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (cols.value <= 0 || props.albums.length === 0) return
  const target = props.rememberedAlbumId
  if (target !== null && target !== undefined && scrollToAlbum(target, opts)) {
    return
  }
  virtualizer.value.scrollToIndex(0, { align: 'start' })
}

defineExpose({ scrollToAlbum, rescrollToRemembered })

// ── Initial scroll when data + layout settle ─────────────────────────────────
// The parent loads albums asynchronously, and ResizeObserver picks the column
// count after first paint. Try once on every relevant change, but only fire
// the scroll once so subsequent re-filters don't yank the user back — those
// are driven by the parent calling `rescrollToRemembered()` explicitly.
let initialScrollDone = false

async function tryInitialScroll() {
  if (initialScrollDone) return
  if (!props.rememberedAlbumId) return
  if (cols.value <= 0 || props.albums.length === 0) return
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (scrollToAlbum(props.rememberedAlbumId, { highlight: true, focus: true })) {
    initialScrollDone = true
  }
}

watch(
  () => [props.albums.length, cols.value, props.rememberedAlbumId] as const,
  () => { void tryInitialScroll() },
  { immediate: true },
)
</script>

<template>
  <div ref="scrollRef" class="vag" @keydown="handleContainerKeydown">
    <div class="vag__inner" :style="{ height: `${totalSize}px` }">
      <div
        v-for="row in virtualRows"
        :key="String(row.key)"
        class="vag__row"
        :style="{
          transform: `translateY(${row.start}px)`,
          height: `${rowHeight}px`,
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
        }"
      >
        <div
          v-for="album in rowAlbums(row.index)"
          :key="album.id"
          :data-album-id="album.id"
          class="album-card"
          :class="{ 'album-card--restored-focus': restoredFocusId === album.id }"
          tabindex="0"
          @click="emit('open', album)"
          @keydown.enter="emit('open', album)"
          @keydown.space.prevent="emit('open', album)"
        >
          <div class="album-cover">
            <HeicImage
              v-if="album.cover_filename"
              :src="getPhotoUrl(album.cover_filename, 400)"
              :alt="album.name"
              objectFit="cover"
            />
            <div v-else class="album-icon">
              <i class="pi pi-images"/>
            </div>
          </div>
          <i v-if="album.is_shared" class="pi pi-share-alt shared-badge" v-tooltip="'Freigegeben'" />
          <div class="album-info">
            <span class="album-name">{{ album.name }}</span>
            <span v-if="album.description" class="album-desc">{{ album.description }}</span>
            <span class="album-meta">
              {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
              <template v-if="album.oldest_photo_at && album.newest_photo_at">
                • {{ new Date(album.oldest_photo_at).toLocaleDateString() }} - {{ new Date(album.newest_photo_at).toLocaleDateString() }}
              </template>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vag {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  contain: layout size style;
  padding: 6px;
  box-sizing: border-box;
}

.vag__inner {
  position: relative;
  width: 100%;
}

.vag__row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: grid;
  column-gap: 4px;
  padding-bottom: 4px;
  box-sizing: border-box;
}

.album-card {
  position: relative;
  background: var(--p-content-background);
  /* No border — outline handles focus/restored-focus and we need the full
     cell width for a 140-px-wide tile that mirrors the gallery thumb. */
  border: none;
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
  transition: transform 0.2s;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  outline: none;
  height: 100%;
}

.album-card:hover { transform: scale(1.02); }

.album-card:focus,
.album-card.album-card--restored-focus {
  outline: 3px solid var(--p-focus-ring-color);
  outline-offset: 2px;
}

.shared-badge {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  z-index: 1;
  font-size: 0.9rem;
  color: white;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 50%;
  padding: 0.35rem;
  backdrop-filter: blur(4px);
}

.album-cover {
  width: 100%;
  height: 100%;
  background: var(--p-content-hover-background);
  overflow: hidden;
}
.album-cover :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}
.album-icon {
  font-size: 3rem;
  color: var(--p-primary-color);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.album-info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0.4rem 0.6rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  color: #fff;
}
.album-name {
  font-weight: 500;
  font-size: 0.85rem;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.album-desc {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.album-meta {
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.75);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
