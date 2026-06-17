<script setup lang="ts">
/**
 * Virtualized grid of person cards.
 *
 * Mirrors the architecture of VirtualAlbumGrid: TanStack useVirtualizer
 * virtualizes ROWS. Each row is a CSS grid holding `cols` person cards;
 * row height is fixed so total scroll height is computed without measuring.
 *
 * Data source: caller's in-memory sorted+filtered persons array — no
 * server pagination. Arrow-key navigation and scroll restoration work the
 * same way as VirtualAlbumGrid.
 *
 * Public API (defineExpose):
 *   - scrollToPerson(id, opts) — center the card for person `id`, optionally
 *     focus and/or briefly highlight it.
 *   - rescrollToRemembered(opts) — re-apply after filter/sort changes.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import HeicImage from './HeicImage.vue'
import { type Person, getPhotoUrl } from '../api/photos'
import { thumbnailImageStyle } from '../utils/faceBbox'

const props = defineProps<{
  persons: Person[]
  rememberedPersonId?: number | null
}>()

const emit = defineEmits<{
  'person-click': [person: Person]
}>()

// ── Layout ───────────────────────────────────────────────────────────────────
// Constants match VirtualAlbumGrid / VirtualGallery for visual consistency.
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
    const style = getComputedStyle(scrollRef.value)
    const hPad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    recalcLayout(scrollRef.value.clientWidth - hPad)
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
  if (restoredClearTimer) { clearTimeout(restoredClearTimer); restoredClearTimer = null }
})

// ── Virtualizer ──────────────────────────────────────────────────────────────
const rowCount = computed(() => Math.ceil(props.persons.length / Math.max(1, cols.value)))

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

function rowPersons(rowIndex: number): Person[] {
  const start = rowIndex * cols.value
  return props.persons.slice(start, Math.min(start + cols.value, props.persons.length))
}

function coverUrl(person: Person): string {
  return person.cover_filename ? getPhotoUrl(person.cover_filename, 400) : ''
}

// ── Restored-focus highlight ─────────────────────────────────────────────────
const restoredFocusId = ref<number | null>(null)
let restoredClearTimer: ReturnType<typeof setTimeout> | null = null

function highlightPerson(id: number) {
  restoredFocusId.value = id
  if (restoredClearTimer) clearTimeout(restoredClearTimer)
  restoredClearTimer = setTimeout(() => { restoredFocusId.value = null; restoredClearTimer = null }, 2500)
}

// ── Keyboard navigation ──────────────────────────────────────────────────────
function handleKeydown(e: KeyboardEvent) {
  const focused = scrollRef.value?.querySelector<HTMLElement>('[data-person-id]:focus')
  if (!focused) return
  const id = Number(focused.dataset.personId)
  const idx = props.persons.findIndex(p => p.id === id)
  if (idx < 0) return

  let next: number
  if (e.key === 'ArrowRight') next = Math.min(idx + 1, props.persons.length - 1)
  else if (e.key === 'ArrowLeft') next = Math.max(idx - 1, 0)
  else if (e.key === 'ArrowDown') next = Math.min(idx + cols.value, props.persons.length - 1)
  else if (e.key === 'ArrowUp') next = Math.max(idx - cols.value, 0)
  else return

  e.preventDefault()
  if (next === idx) return
  const target = props.persons[next]
  if (target) scrollToPerson(target.id, { focus: true })
}

// ── Public API ───────────────────────────────────────────────────────────────
function scrollToPerson(id: number, opts: { highlight?: boolean; focus?: boolean } = {}): boolean {
  if (cols.value <= 0 || props.persons.length === 0) return false
  const idx = props.persons.findIndex(p => p.id === id)
  if (idx < 0) return false
  virtualizer.value.scrollToIndex(Math.floor(idx / cols.value), { align: 'center' })
  if (opts.highlight) highlightPerson(id)
  if (opts.focus) {
    requestAnimationFrame(() => {
      scrollRef.value?.querySelector<HTMLElement>(`[data-person-id="${id}"]`)?.focus({ preventScroll: true })
    })
  }
  return true
}

async function rescrollToRemembered(opts: { highlight?: boolean } = {}) {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (!props.rememberedPersonId || props.persons.length === 0) return
  if (!scrollToPerson(props.rememberedPersonId, opts)) {
    virtualizer.value.scrollToIndex(0, { align: 'start' })
  }
}

defineExpose({ scrollToPerson, rescrollToRemembered })

// ── Initial scroll on mount ──────────────────────────────────────────────────
let initialScrollDone = false

async function tryInitialScroll() {
  if (initialScrollDone || !props.rememberedPersonId) return
  if (cols.value <= 0 || props.persons.length === 0) return
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (scrollToPerson(props.rememberedPersonId, { highlight: true })) initialScrollDone = true
}

watch(
  () => [props.persons.length, cols.value, props.rememberedPersonId] as const,
  () => { void tryInitialScroll() },
  { immediate: true },
)
</script>

<template>
  <div ref="scrollRef" class="pg" @keydown="handleKeydown">
    <div v-if="persons.length === 0" class="pg-empty">
      Keine Personen passen zum Filter.
    </div>
    <div class="pg-inner" :style="{ height: `${totalSize}px` }">
      <div
        v-for="row in virtualRows"
        :key="String(row.key)"
        class="pg-row"
        :style="{
          transform: `translateY(${row.start}px)`,
          height: `${row.size}px`,
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
        }"
      >
        <button
          v-for="person in rowPersons(row.index)"
          :key="person.id"
          type="button"
          :data-person-id="person.id"
          class="person-card"
          :class="{ 'person-card--focus': restoredFocusId === person.id }"
          :style="{ height: `${CELL_HEIGHT}px` }"
          @click="emit('person-click', person)"
        >
          <div class="person-card-thumb">
            <HeicImage
              v-if="person.cover_filename"
              :src="coverUrl(person)"
              :alt="person.name"
              objectFit="cover"
              :imageStyle="thumbnailImageStyle(person.cover_bbox)"
            />
            <div v-else class="person-card-placeholder">
              <i class="pi pi-user" />
            </div>
          </div>
          <div class="person-card-info">
            <span class="person-card-name">{{ person.name }}</span>
            <span class="person-card-count">{{ person.faceCount || 0 }} Fotos</span>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg {
  flex: 1;
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

.pg-empty {
  padding: 2rem 1rem;
  text-align: center;
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

.person-card {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 4px;
  overflow: hidden;
  background: var(--p-content-hover-background);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  outline: none;
  color: inherit;
  text-align: left;
  contain: layout paint;
  -webkit-tap-highlight-color: transparent;
}

.person-card:focus-visible::after,
.person-card--focus::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 3px solid var(--p-focus-ring-color);
  border-radius: 4px;
  pointer-events: none;
  z-index: 20;
}

.person-card-thumb {
  width: 100%;
  height: 100%;
  background: var(--p-content-hover-background);
  overflow: hidden;
}

.person-card-thumb :deep(.heic-image-container) { width: 100%; height: 100%; }

.person-card-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 3rem;
  color: var(--p-text-muted-color);
}

.person-card-info {
  padding: 0.35rem 0.6rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  color: #fff;
}

.person-card-name {
  font-size: 0.85rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.person-card-count {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.8);
  flex-shrink: 0;
}
</style>
