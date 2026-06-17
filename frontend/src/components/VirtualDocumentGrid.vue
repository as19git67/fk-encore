<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import Checkbox from 'primevue/checkbox'
import Chip from 'primevue/chip'
import Tag from 'primevue/tag'
import DocumentThumbnail from './DocumentThumbnail.vue'
import type { DocumentStatus, DocumentSummary } from '../api/documents'

const props = defineProps<{
  items: DocumentSummary[]
  selectedIds: Set<number>
  scrollElement: HTMLElement | Window | null
  statusSeverity: (status: DocumentStatus) => 'success' | 'info' | 'warn' | 'danger' | 'secondary'
  statusLabel: (status: DocumentStatus) => string
  formatDate: (dateStr: string | null) => string
}>()

const emit = defineEmits<{
  open: [doc: DocumentSummary]
  'toggle-selected': [id: number, checked: boolean]
}>()

const TARGET_CELL_MIN_PX = 220
const GAP_PX = 12
const ROW_HEIGHT = 315

const width = ref(0)
const measureRef = ref<HTMLElement | null>(null)
let resizeObs: ResizeObserver | null = null

function measure() {
  width.value = measureRef.value?.clientWidth ?? 0
}

onMounted(() => {
  measure()
  if (!measureRef.value) return
  resizeObs = new ResizeObserver(measure)
  resizeObs.observe(measureRef.value)
})

onBeforeUnmount(() => {
  resizeObs?.disconnect()
  resizeObs = null
})

const cols = computed(() => Math.max(1, Math.floor((Math.max(width.value, TARGET_CELL_MIN_PX) + GAP_PX) / (TARGET_CELL_MIN_PX + GAP_PX))))
const rowCount = computed(() => Math.ceil(props.items.length / cols.value))
const virtualizer = useVirtualizer(computed(() => ({
  count: rowCount.value,
  getScrollElement: () => props.scrollElement,
  estimateSize: () => ROW_HEIGHT,
  overscan: 4,
})))
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

function rowDocs(rowIndex: number): DocumentSummary[] {
  const start = rowIndex * cols.value
  const end = Math.min(start + cols.value, props.items.length)
  return props.items.slice(start, end)
}
</script>

<template>
  <div ref="measureRef" class="vdg">
    <div class="vdg-inner" :style="{ height: `${totalSize}px` }">
      <div
        v-for="row in virtualRows"
        :key="String(row.key)"
        class="vdg-row"
        :style="{
          transform: `translateY(${row.start}px)`,
          height: `${ROW_HEIGHT}px`,
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        }"
      >
        <div
          v-for="doc in rowDocs(row.index)"
          :key="doc.id"
          :data-doc-id="doc.id"
          class="grid-card"
          :class="{ 'grid-card--selected': selectedIds.has(doc.id) }"
          tabindex="0"
          @click="emit('open', doc)"
          @keydown.enter="emit('open', doc)"
        >
          <div class="grid-card-checkbox" @click.stop>
            <Checkbox
              :modelValue="selectedIds.has(doc.id)"
              :binary="true"
              :aria-label="`Dokument ${doc.title || doc.original_filename} auswählen`"
              @update:modelValue="(val: boolean) => emit('toggle-selected', doc.id, val)"
            />
          </div>
          <div class="grid-card-thumb">
            <DocumentThumbnail :id="doc.id" :alt="doc.title || doc.original_filename" />
          </div>
          <Tag class="grid-card-status" :severity="statusSeverity(doc.status)" :value="statusLabel(doc.status)" />
          <div class="grid-card-title">{{ doc.title || doc.original_filename }}</div>
          <div class="grid-card-meta">
            <span v-if="doc.sender">{{ doc.sender }}</span>
            <span v-if="doc.doc_date">{{ formatDate(doc.doc_date) }}</span>
          </div>
          <div v-if="doc.category_slug" class="grid-card-category">
            <i class="pi pi-folder" /> {{ doc.category_slug }}
          </div>
          <div v-if="doc.tags.length > 0" class="grid-card-tags">
            <Chip v-for="tag in doc.tags.slice(0, 3)" :key="tag" :label="tag" />
            <span v-if="doc.tags.length > 3" class="more-tags">+{{ doc.tags.length - 3 }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vdg { width: 100%; }
.vdg-inner { position: relative; width: 100%; }
.vdg-row { position: absolute; top: 0; left: 0; right: 0; display: grid; gap: .75rem; box-sizing: border-box; }
.grid-card { display: flex; flex-direction: column; gap: .4rem; padding: .75rem; background: var(--p-content-background); border: 1px solid var(--p-content-border-color); border-radius: 10px; cursor: pointer; transition: box-shadow .15s, transform .1s; position: relative; min-width: 0; }
.grid-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,.1); transform: translateY(-1px); }
.grid-card:focus-visible { outline: 2px solid var(--p-primary-color); outline-offset: 2px; }
.grid-card--selected { outline: 2px solid var(--p-primary-color); outline-offset: 2px; background: color-mix(in srgb, var(--p-primary-color) 6%, var(--p-content-background)); }
.grid-card-checkbox { position: absolute; top: .5rem; right: .5rem; z-index: 1; }
.grid-card-title { font-weight: 600; line-height: 1.2; overflow: hidden; min-height: 2.4em; }
.grid-card-meta { display: flex; flex-direction: column; gap: .15rem; font-size: .82rem; color: var(--p-text-muted-color); min-height: 2.1em; }
.grid-card-category { display: inline-flex; align-items: center; gap: .25rem; font-size: .85rem; color: var(--p-primary-color); }
.grid-card-tags { display: flex; flex-wrap: wrap; gap: .2rem; align-items: center; min-height: 1.5rem; }
.more-tags { font-size: .8rem; color: var(--p-text-muted-color); }
</style>
