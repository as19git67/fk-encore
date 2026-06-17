<script setup lang="ts">
/** Virtualized list renderer for DocumentsView. */
import { computed } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import Checkbox from 'primevue/checkbox'
import Chip from 'primevue/chip'
import Tag from 'primevue/tag'
import type { DocumentStatus, DocumentSummary } from '../api/documents'

const props = defineProps<{
  items: DocumentSummary[]
  selectedIds: Set<number>
  scrollElement: HTMLElement | Window | null
  isLowConfidence: (doc: DocumentSummary) => boolean
  statusSeverity: (status: DocumentStatus) => 'success' | 'info' | 'warn' | 'danger' | 'secondary'
  statusLabel: (status: DocumentStatus) => string
  formatDate: (dateStr: string | null) => string
  formatSize: (bytes: number) => string
}>()

const emit = defineEmits<{
  open: [doc: DocumentSummary]
  'toggle-selected': [id: number, checked: boolean]
}>()

const ROW_HEIGHT = 148

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.items.length,
    getScrollElement: () => props.scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  })),
)
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())
</script>

<template>
  <div class="vdl" :style="{ height: `${totalSize}px` }">
    <div
      v-for="row in virtualRows"
      :key="String(row.key)"
      class="vdl-row"
      :style="{ transform: `translateY(${row.start}px)` }"
    >
      <div
        v-if="items[row.index]"
        :data-doc-id="items[row.index]!.id"
        class="document-card"
        :class="{ 'document-card--selected': selectedIds.has(items[row.index]!.id) }"
      >
        <div class="document-header">
          <div class="document-checkbox" @click.stop>
            <Checkbox
              :modelValue="selectedIds.has(items[row.index]!.id)"
              :binary="true"
              :inputId="`doc-sel-${items[row.index]!.id}`"
              :aria-label="`Dokument ${items[row.index]!.title || items[row.index]!.original_filename} auswählen`"
              @update:modelValue="(val: boolean) => emit('toggle-selected', items[row.index]!.id, val)"
            />
          </div>
          <div class="document-icon"><i class="pi pi-file-pdf" /></div>
          <button
            type="button"
            class="document-title"
            v-tooltip.bottom="'Dokument öffnen'"
            @click="emit('open', items[row.index]!)"
          >
            {{ items[row.index]!.title || items[row.index]!.original_filename }}
          </button>
          <Tag :severity="statusSeverity(items[row.index]!.status)" :value="statusLabel(items[row.index]!.status)" />
          <Tag
            v-if="isLowConfidence(items[row.index]!)"
            severity="warn"
            icon="pi pi-exclamation-triangle"
            :value="`Prüfen · ${Math.round((items[row.index]!.classification_confidence ?? 0) * 100)}%`"
            v-tooltip.bottom="'Niedrige KI-Konfidenz — Kategorie und Felder bitte prüfen.'"
          />
        </div>
        <div class="document-details">
          <div class="document-meta">
            <span v-if="items[row.index]!.category_slug" class="document-category">
              <i class="pi pi-folder" /> {{ items[row.index]!.category_slug }}
            </span>
            <span v-if="items[row.index]!.sender"><i class="pi pi-user" /> {{ items[row.index]!.sender }}</span>
            <span v-if="items[row.index]!.doc_date"><i class="pi pi-calendar" /> {{ formatDate(items[row.index]!.doc_date) }}</span>
            <span class="document-size"><i class="pi pi-database" /> {{ formatSize(items[row.index]!.size_bytes) }}</span>
            <span v-if="items[row.index]!.tax_relevant" class="tax-badge"><i class="pi pi-calculator" /> Steuer</span>
          </div>
          <div v-if="items[row.index]!.status === 'failed' && items[row.index]!.last_error" class="document-error">
            <i class="pi pi-times-circle" /> {{ items[row.index]!.last_error }}
          </div>
          <div v-if="items[row.index]!.tags.length > 0" class="document-tags">
            <Chip v-for="tag in items[row.index]!.tags" :key="tag" :label="tag" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vdl { position: relative; width: 100%; }
.vdl-row { position: absolute; top: 0; left: 0; right: 0; padding-bottom: 0.5rem; box-sizing: border-box; }
.document-card { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem 1rem; background: var(--p-content-background); border: 1px solid var(--p-content-border-color); border-radius: 8px; transition: box-shadow 0.1s; }
.document-card:hover { box-shadow: 0 2px 6px rgba(0,0,0,.08); }
.document-card--selected { outline: 2px solid var(--p-primary-color); outline-offset: 2px; background: color-mix(in srgb, var(--p-primary-color) 6%, var(--p-content-background)); }
.document-card--highlight { animation: card-flash 1.5s ease-out; }
@keyframes card-flash { 0% { box-shadow: 0 0 0 3px var(--p-primary-color); } 100% { box-shadow: none; } }
.document-header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.document-checkbox { flex-shrink: 0; display: flex; align-items: center; }
.document-icon { font-size: 2rem; line-height: 1; color: var(--p-primary-color); flex-shrink: 0; display: flex; align-items: center; }
.document-details { display: flex; flex-direction: column; gap: .4rem; }
.document-title { appearance: none; background: none; border: none; margin: 0; padding: 0; font: inherit; font-weight: 600; color: inherit; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.document-title:hover, .document-title:focus-visible { text-decoration: underline; color: var(--p-primary-color); }
.document-meta { display: flex; flex-wrap: wrap; gap: .75rem; font-size: .85rem; color: var(--p-text-muted-color); }
.document-meta span { display: inline-flex; align-items: center; gap: .25rem; }
.tax-badge { color: var(--p-primary-color); font-weight: 500; }
.document-error { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem; color: var(--p-red-600, #c0392b); background: var(--p-red-50, #fdecea); padding: .3rem .5rem; border-radius: 6px; word-break: break-word; }
.document-tags { display: flex; flex-wrap: wrap; gap: .25rem; }
</style>
