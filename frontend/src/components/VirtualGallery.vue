<script setup lang="ts">
/**
 * Virtualized photo gallery grid.
 *
 * Architecture:
 *   - Owns a `useGallerySource` (sparse array of length `total`). The
 *     component never iterates this array; it only reads slots inside the
 *     rendered rows.
 *   - TanStack `useVirtualizer` virtualizes ROWS (not items). A row holds
 *     `cols` photos; layout inside the row is a plain CSS grid. Row height
 *     is fixed (cell + gap) so the virtualizer can compute the total
 *     scroll height as `rowCount * rowHeight` without measuring.
 *   - As soon as a row becomes visible, the component asks the source to
 *     `ensureRange(rowStart, rowEnd)` — the source fires page fetches for
 *     any unloaded slots that overlap the visible window.
 *   - Filter / sort / search state come in as reactive props. A change to
 *     any of them triggers a fresh `init` (full reload + scroll back to
 *     the anchor).
 *   - Selection state (`selectMode`, `selectedIds`) is also a reactive
 *     prop. The component just maps it to a CSS class on each cell — it
 *     doesn't manage selection itself, the parent does (so the user can
 *     act on the set with Album / Hide / Favorite buttons in a toolbar).
 *
 * What it emits:
 *   - `photo-click(entry)`        — normal tap on a non-stack cell.
 *   - `stack-click(entry)`        — tap on a stack-cover cell (the parent
 *                                    typically opens the compare view).
 *   - `toggle-select(entry)`      — tap while `selectMode` is true.
 *
 * What it exposes (via defineExpose):
 *   - `updateEntry(id, partial)` — optimistic in-place mutation (curation).
 *   - `reload(opts?)`             — re-init keeping current query state.
 *   - `getTotal()` / `getCols()`  — current total photo count / column count.
 *                                    Used by the fullscreen viewer to compute
 *                                    prev/next bounds and ↑/↓ row jumps.
 *   - `loadEntryAt(index)`        — async accessor that resolves the entry at
 *                                    `index`, awaiting the page fetch if the
 *                                    slot is still null. Used by the
 *                                    fullscreen viewer to navigate beyond the
 *                                    currently-loaded window.
 *   - `findLoadedIndexById(id)`   — linear scan over loaded entries; returns
 *                                    `null` for ids that aren't in the
 *                                    currently loaded window. Used to map a
 *                                    `?photoId=` deeplink to its grid index.
 *   - `scrollToIndex(index)`      — scroll the grid so `index` lands centered
 *                                    in the viewport. Used to keep the grid
 *                                    aligned with the fullscreen selection.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { getThumbUrl, type GalleryGridEntry, type GallerySortDir, type GallerySortField } from '../api/gallery'
import { useGallerySource, GALLERY_PAGE_SIZE } from '../composables/useGallerySource'
import type { PhotoFilter } from '../api/photos'

const props = defineProps<{
  /** Photo to land on initially. Null = land on the last (newest in ASC) page. */
  aroundPhotoId?: number | null
  /** Server-side filter. Changing it triggers a fresh init. */
  filter: PhotoFilter
  sortBy: GallerySortField
  sortDir: GallerySortDir
  /**
   * Search-result IDs in ranked order. Non-null/non-empty = search mode:
   * server returns only these photos in this order, ignoring sort.
   */
  searchPhotoIds?: number[] | null
  /** When true, taps go through `toggle-select` instead of `photo-click`. */
  selectMode?: boolean
  /** Set of currently-selected photo IDs (driven by parent). */
  selectedIds?: Set<number>
  /**
   * Absolute index of the keyboard-navigation cursor (or `null` when no
   * cursor is active). The matching cell gets a distinct ring so the user
   * can see where ↑/↓/←/→ will move next; ignored on touch-only sessions
   * where the parent never sets it.
   */
  cursorIndex?: number | null
}>()

const emit = defineEmits<{
  'photo-click': [entry: GalleryGridEntry]
  'stack-click': [entry: GalleryGridEntry]
  'toggle-select': [entry: GalleryGridEntry]
  /** Fires after a (re)load completes so the parent can show toasts etc. */
  'loaded': [info: { total: number; offset: number }]
  /**
   * Fires whenever the scroll container's at-start / at-end state
   * changes. Lets the parent's "jump to newest / oldest" toolbar
   * button flip its label without polling.
   */
  'ends-changed': [ends: { atStart: boolean; atEnd: boolean }]
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
const containerWidth = ref(0)
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
  containerWidth.value = width
}

// ── Bandwidth-aware overscan ────────────────────────────────────────────────
// Each row of overscan mounts `cols` extra <img> tags whose lazy-load
// deadline overlaps the visible viewport. On a phone with cells=3 and
// the previous overscan=4 that meant 24 thumbnail requests beyond the
// 5–6 rows actually on screen — a noticeable chunk of mobile data on a
// fresh app start, even with the browser's lazy-load defer-margin.
//
// We read the `Network Information API` once at mount (Chrome / Android /
// Firefox; iOS Safari has no equivalent so we fall through to viewport
// width). `save-data` and 2G/3G effective types collapse the overscan
// to 1; narrow grids (< 768 px = mobile / split-pane) get 2; the
// original 4 stays on desktop where bandwidth isn't the bottleneck.
function detectSlowConnection(): boolean {
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (!conn) return false
  if (conn.saveData) return true
  return ['slow-2g', '2g', '3g'].includes(conn.effectiveType ?? '')
}
const slowConnection = detectSlowConnection()
const overscan = computed(() => {
  if (slowConnection) return 1
  if (containerWidth.value > 0 && containerWidth.value < 768) return 2
  return 4
})

// ── Scroll-end detection ────────────────────────────────────────────────────
// Tracked reactively so the parent's "jump to newest / oldest" toolbar
// button can flip its label/icon based on which end of the scroll
// container the user is currently parked at. Updated on every scroll
// event (passive listener) plus once after each (re)load so the initial
// scroll-to-anchor settles cleanly.
let lastEnds: { atStart: boolean; atEnd: boolean } = { atStart: true, atEnd: false }
function updateScrollEnds() {
  const el = scrollRef.value
  if (!el) return
  const next = {
    atStart: el.scrollTop <= 1,
    atEnd: Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1,
  }
  if (next.atStart !== lastEnds.atStart || next.atEnd !== lastEnds.atEnd) {
    lastEnds = next
    emit('ends-changed', next)
  }
}

onMounted(() => {
  if (scrollRef.value) {
    recalcLayout(scrollRef.value.clientWidth)
    resizeObs = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) recalcLayout(entry.contentRect.width)
    })
    resizeObs.observe(scrollRef.value)
    scrollRef.value.addEventListener('scroll', updateScrollEnds, { passive: true })
  }
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
  scrollRef.value?.removeEventListener('scroll', updateScrollEnds)
  if (trailingTimer) {
    clearTimeout(trailingTimer)
    trailingTimer = null
  }
  source.cancel()
})

// ── Row count drives the virtualizer ────────────────────────────────────────
const rowCount = computed(() => Math.ceil((total.value ?? 0) / cols.value))

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rowCount.value,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => rowHeight.value,
    overscan: overscan.value,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

function rowSlots(rowIndex: number): (GalleryGridEntry | null)[] {
  const start = rowIndex * cols.value
  const end = Math.min(start + cols.value, total.value ?? 0)
  if (start >= end) return []
  return entries.value.slice(start, end)
}

// ── Edge prefetch ───────────────────────────────────────────────────────────
// Throttled, leading-edge + trailing call: the first scroll event always
// fires immediately so cells in the new viewport start filling without a
// perceptible delay; subsequent events within `THROTTLE_MS` coalesce into
// a single trailing fire. Pure debounce was a trap (continuous wheel
// scroll kept resetting the timer, prefetch never fired, permanent
// skeletons); pure no-throttle was 300+ requests on an end-to-end scroll
// because every scroll-event surfaced a fresh viewport and re-triggered
// `ensureRange`.
//
// Each call also asks the source to abort any in-flight page whose range
// is entirely outside the new window, so pages the user has scrolled past
// stop downloading. Aborted pages drop out of pagePromises in fetchPage's
// catch block, so scrolling back resurrects them.
const THROTTLE_MS = 150
let lastFire = 0
let trailingTimer: ReturnType<typeof setTimeout> | null = null

function runPrefetch() {
  const rows = virtualizer.value.getVirtualItems()
  if (rows.length === 0 || total.value === 0) return
  const firstIdx = rows[0]!.index * cols.value
  const lastIdx = (rows[rows.length - 1]!.index + 1) * cols.value
  const start = Math.max(0, firstIdx - GALLERY_PAGE_SIZE)
  const end = Math.min(total.value, lastIdx + GALLERY_PAGE_SIZE)
  source.cancelOutside(start, end)
  source.ensureRange(start, end)
}

function schedulePrefetch() {
  if (isInitialLoading.value) return
  const now = Date.now()
  const elapsed = now - lastFire
  if (elapsed >= THROTTLE_MS) {
    if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null }
    runPrefetch()
    lastFire = now
    return
  }
  if (trailingTimer) return
  trailingTimer = setTimeout(() => {
    trailingTimer = null
    runPrefetch()
    lastFire = Date.now()
  }, THROTTLE_MS - elapsed)
}

watch(virtualRows, schedulePrefetch, { flush: 'post' })

// ── Initial + re-init on query change ───────────────────────────────────────
const ready = ref(false)
const isInitialLoading = ref(true)

async function loadAndScroll(anchor: number | null | undefined) {
  ready.value = false
  const { initialOffset, total: totalRows } = await source.init({
    filter: props.filter,
    sortBy: props.sortBy,
    sortDir: props.sortDir,
    photoIds: props.searchPhotoIds ?? null,
    aroundPhotoId: anchor ?? null,
  })
  ready.value = true
  emit('loaded', { total: totalRows, offset: initialOffset })
  // Wait one frame so the virtualizer has measured the container with the
  // new total before we ask it to scroll.
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (cols.value > 0 && totalRows > 0) {
    // If we loaded around a specific anchor photo, find its exact index in
    // the loaded window and scroll there. Falling back to initialOffset
    // (start of the loaded window) would land ~250 photos before the target.
    let targetRow = Math.floor(initialOffset / cols.value)
    if (anchor) {
      const exactIdx = findLoadedIndexById(anchor)
      if (exactIdx !== null) targetRow = Math.floor(exactIdx / cols.value)
    }
    virtualizer.value.scrollToIndex(targetRow, { align: 'center' })
  } else if (totalRows > 0) {
    virtualizer.value.scrollToIndex(0, { align: 'start' })
  }
  // After the post-init scroll settles, refresh the at-start / at-end
  // state so the parent's "jump to newest / oldest" toolbar button
  // labels itself correctly without waiting for the user's first scroll.
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  updateScrollEnds()
  
  // Allow prefetches to start after initial positioning is done.
  await new Promise<void>((r) => setTimeout(r, 200))
  isInitialLoading.value = false
}

onMounted(() => {
  // Wait one frame so ResizeObserver has settled the column count.
  requestAnimationFrame(() => { void loadAndScroll(props.aroundPhotoId) })
})

// React to query changes (filter, sort, search). Each change is a full
// reload — same semantics as the legacy gallery's loadPhotos(), but
// without ever materializing the full library client-side. We DO NOT
// watch `aroundPhotoId` past mount because that prop is "initial only"
// (a deep-link photoId or stored ID) — the parent shouldn't re-trigger
// based on it. Selection prop changes are also intentionally NOT watched
// here: they only affect the visual highlight on cells, which Vue picks
// up automatically through `selectedIds.has(slot.id)` in the template.
/**
 * Re-init on filter / sort / search change. Anchors the new window on
 * whatever photo is currently in the viewport top-left so the user's
 * position is preserved across the reload — passing `null` would make
 * the server centre on `total - limit` (the newest page), which is
 * what the user noticed as "Position verloren, springt zum neuesten
 * Foto" when toggling the AI-hidden filter.
 *
 * Falls back to `null` (centre on newest) when no row is currently
 * loaded — e.g. the very first init right after mount.
 */
function currentViewportAnchorId(): number | null {
  const rows = virtualizer.value.getVirtualItems()
  if (rows.length === 0) return null
  const firstIdx = rows[0]!.index * cols.value
  const entry = entries.value[firstIdx]
  return entry?.id ?? null
}

watch(
  () => [props.filter, props.sortBy, props.sortDir, props.searchPhotoIds] as const,
  () => {
    void loadAndScroll(currentViewportAnchorId())
  },
  { deep: true },
)

// ── Click handling ──────────────────────────────────────────────────────────
function onTap(entry: GalleryGridEntry | null, event?: MouseEvent) {
  if (!entry) return
  if (props.selectMode) {
    emit('toggle-select', entry)
    return
  }
  // Track-I semantics (see docs/ai-auto-pick.md): only a tap on the
  // +N marker opens the review dialog — every other tap on the tile
  // opens the photo fullscreen, even for group members. The KI's pick
  // is the default view; the marker is the affordance to drill into
  // the rest of the group.
  const target = event?.target as HTMLElement | null
  const onMarker = !!entry.group && !!target?.closest('.vg-stack-badge')
  if (onMarker) {
    emit('stack-click', entry)
  } else {
    emit('photo-click', entry)
  }
}

/** "Sind die übrigen Gruppenmitglieder gerade KI-versteckt?" Wahr nur
 *  bei high-confidence Gruppen ohne reviewed_at — exakt die Bedingung
 *  unter der der Server aiHiddenMode=exclude die Geschwister aus
 *  diesem Grid filtert. */
function isAiHidingSiblings(group: GalleryGridEntry['group'] | null | undefined): boolean {
  if (!group) return false
  if (group.reviewed) return false
  return group.ai_confidence === 'high'
}

function badgeTitle(group: GalleryGridEntry['group'] | null | undefined): string {
  if (!group) return ''
  if (isAiHidingSiblings(group)) {
    return `${group.member_count - 1} ähnliche Fotos werden ausgeblendet – klicken zum Anzeigen`
  }
  if (group.ai_confidence === 'medium') return 'KI-Vorschlag mit mittlerer Sicherheit – bitte prüfen'
  if (group.ai_confidence === 'low') return 'KI-Vorschlag mit niedriger Sicherheit'
  return `${group.member_count} ähnliche Fotos`
}

// ── Public surface for the parent ───────────────────────────────────────────
function findLoadedIndexById(id: number): number | null {
  const arr = entries.value
  for (let i = 0; i < arr.length; i++) {
    if (arr[i]?.id === id) return i
  }
  return null
}

function scrollToIndex(index: number, align: 'start' | 'center' | 'end' | 'auto' = 'center') {
  if (cols.value <= 0 || total.value === 0) return
  const clamped = Math.max(0, Math.min(index, total.value - 1))
  const row = Math.floor(clamped / cols.value)
  virtualizer.value.scrollToIndex(row, { align })
}

defineExpose({
  updateEntry: source.updateEntry,
  markGroupReviewed: source.markGroupReviewed,
  reload: source.reload,
  loadEntryAt: source.loadEntryAt,
  findLoadedIndexById,
  scrollToIndex,
  // Getter style (rather than raw refs) so the parent reads the value with
  // a simple call instead of `.value.ref.value` chains.
  getTotal: () => total.value,
  getCols: () => cols.value,
})
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
              'vg-cell--stack': !!slot.group && !slot.group.reviewed,
              'vg-cell--stack-cover': !!slot.group && !slot.group.reviewed && slot.group.is_cover,
              'vg-cell--selected': selectedIds && selectedIds.has(slot.id),
              'vg-cell--cursor': cursorIndex === row.index * cols + i,
            }"
            :style="{ height: `${cellSize}px` }"
            @click="onTap(slot, $event)"
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
            <!-- Track-I marker. Shows on every member of an unreviewed
                 group so the user can launch the review from any tile.
                 The icon differentiates AI-hiding-siblings (pi-eye-slash,
                 high confidence) from the medium / low confidence cases
                 (no icon, just +N). -->
            <span
              v-if="slot.group && !slot.group.reviewed"
              class="vg-stack-badge"
              :class="{
                'vg-stack-badge--ai-medium': slot.group.ai_confidence === 'medium',
                'vg-stack-badge--ai-low': slot.group.ai_confidence === 'low',
              }"
              :title="badgeTitle(slot.group)"
            >
              <i v-if="isAiHidingSiblings(slot.group)" class="pi pi-eye-slash vg-stack-badge-icon" />
              +{{ slot.group.member_count - 1 }}
            </span>
            <i
              v-if="slot.curation === 'favorite'"
              class="pi pi-heart-fill vg-favorite-icon"
            />
            <i
              v-if="slot.curation === 'hidden'"
              class="pi pi-eye-slash vg-hidden-icon"
            />
            <i
              v-if="selectMode"
              class="pi vg-select-icon"
              :class="selectedIds && selectedIds.has(slot.id) ? 'pi-check-circle' : 'pi-circle'"
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
  contain: layout paint;
  -webkit-tap-highlight-color: transparent;
}

.vg-cell--skeleton {
  cursor: default;
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
  background: var(--p-content-hover-background, #f3f4f6);
}

/* Curation styling — favorites show only a gold heart, no frame (#342) */
.vg-cell--hidden .vg-thumb {
  opacity: 0.55;
  filter: grayscale(0.4);
}

.vg-favorite-icon {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 0.85rem;
  color: var(--p-yellow-400, #facc15);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  pointer-events: none;
}

.vg-hidden-icon {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
  pointer-events: none;
}

/* Stack styling */
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
  padding: 3px 8px;
  border-radius: 999px;
  /* The badge must capture clicks separately from the photo tile so
     onTap() can route marker-clicks to the review dialog while
     leaving plain photo-taps to fall through to the fullscreen view.
     z-index keeps it above the <img> so iOS taps land reliably. */
  cursor: pointer;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.vg-stack-badge:hover {
  background: rgba(0, 0, 0, 0.9);
}
.vg-stack-badge--ai-medium {
  background: var(--p-orange-500, #f97316);
  color: #fff;
}
.vg-stack-badge--ai-medium:hover {
  background: var(--p-orange-600, #ea580c);
}
.vg-stack-badge--ai-low {
  background: rgba(0, 0, 0, 0.55);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.vg-stack-badge-icon {
  font-size: 0.7rem;
}

/* Selection */
.vg-cell--selected {
  outline: 3px solid var(--p-primary-500, #3b82f6);
  outline-offset: -3px;
}

.vg-cell--selected .vg-thumb {
  opacity: 0.8;
}

/* Keyboard cursor — visually distinct from `--selected` (which is the
   batch-curation tick) by using a soft outer ring rather than a hard
   outline, so the two states can co-exist on the same cell. */
.vg-cell--cursor {
  box-shadow: 0 0 0 3px var(--p-primary-300, #93c5fd),
              0 0 0 6px rgba(59, 130, 246, 0.25);
}

.vg-select-icon {
  position: absolute;
  bottom: 6px;
  right: 6px;
  font-size: 1.1rem;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 50%;
  padding: 1px;
  pointer-events: none;
}

.vg-cell--selected .vg-select-icon {
  color: #fff;
  background: var(--p-primary-500, #3b82f6);
}
</style>
