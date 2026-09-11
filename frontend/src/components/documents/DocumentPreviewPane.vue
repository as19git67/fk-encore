<script setup lang="ts">
/**
 * The right-hand half of the split document view: preview plus metadata.
 *
 * Deliberately read-only. The full detail view is a working surface — editing
 * every field, tax assignment, Bezugspersonen, replacing the file, unlocking a
 * password-protected PDF — and squeezing it beside the list would make both
 * halves worse. What the split is for is *reading through a list*: see what a
 * document is without leaving the list, arrow down, see the next one. Editing
 * is one click away and keeps its own full-width page.
 *
 * The document is fetched per selection rather than taken from the list row,
 * because the row carries a summary and this pane shows things only the detail
 * has (summary text, tax sections, retention). Requests are sequenced by the
 * id they were made for: arrowing quickly through a list starts several, and
 * without that check a slow early response could overwrite a fast later one.
 */
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Chip from 'primevue/chip'
import Message from 'primevue/message'
import ProgressSpinner from 'primevue/progressspinner'
import Tag from 'primevue/tag'
import PdfViewer from '../PdfViewer.vue'
import {
  fetchDocumentBytes,
  getDocument,
  type DocumentDetail,
  type DocumentStatus,
} from '../../api/documents'

const props = defineProps<{
  /** The list's current row, or null while the list is empty. */
  documentId: number | null
}>()

const router = useRouter()

/**
 * The pane's own scroll container and the point the jump button aims at. The
 * preview sits above the metadata — the same order the full detail view uses
 * on a narrow screen — so a long PDF pushes the metadata far down; the button
 * in the fixed header is what makes it reachable without a long drag.
 */
const paneBody = ref<HTMLElement | null>(null)
const detailsAnchor = ref<HTMLElement | null>(null)

const doc = ref<DocumentDetail | null>(null)
const pdfData = ref<Uint8Array | null>(null)
const loading = ref(false)
const error = ref('')
const pdfError = ref('')

/**
 * The id the in-flight requests belong to. Arrowing through a list fires one
 * load per row; only the newest may write to the pane.
 */
let inFlightFor: number | null = null

watch(() => props.documentId, load, { immediate: true })

async function load(id: number | null) {
  inFlightFor = id
  error.value = ''
  pdfError.value = ''
  if (id == null) {
    doc.value = null
    pdfData.value = null
    loading.value = false
    return
  }
  loading.value = true
  doc.value = null
  pdfData.value = null
  try {
    const detail = await getDocument(id)
    if (inFlightFor !== id) return
    doc.value = detail
    // A new document starts at the top of its own preview, not wherever the
    // previous one was left.
    paneBody.value?.scrollTo({ top: 0, behavior: 'instant' })
  } catch (err: any) {
    if (inFlightFor !== id) return
    error.value = err?.message ?? 'Dokument konnte nicht geladen werden.'
  } finally {
    if (inFlightFor === id) loading.value = false
  }

  try {
    const bytes = await fetchDocumentBytes(id)
    if (inFlightFor !== id) return
    pdfData.value = bytes
  } catch (err: any) {
    if (inFlightFor !== id) return
    // The metadata is still worth showing when only the file is unreadable.
    pdfError.value = err?.message ?? 'Vorschau konnte nicht geladen werden.'
  }
}

/** Scroll the pane down to the metadata under the preview. */
function scrollToDetails() {
  const body = paneBody.value
  const anchor = detailsAnchor.value
  if (!body || !anchor) return
  body.scrollTo({ top: anchor.offsetTop - body.offsetTop, behavior: 'smooth' })
}

function openFullDetail() {
  if (props.documentId == null) return
  router.push({ name: 'dokumente-detail', params: { id: props.documentId } })
}

function statusSeverity(status: DocumentStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (status) {
    case 'ready': return 'success'
    case 'failed': return 'danger'
    case 'encrypted': return 'warn'
    case 'pending': return 'secondary'
    default: return 'info'
  }
}

function statusLabel(status: DocumentStatus): string {
  switch (status) {
    case 'ready': return 'Fertig'
    case 'failed': return 'Fehler'
    case 'encrypted': return 'Passwortgeschützt'
    case 'pending': return 'Wartet'
    case 'extracting': return 'Text wird gelesen'
    case 'classifying': return 'Wird eingeordnet'
    default: return status
  }
}

function formatDate(value: string | null): string {
  if (!value) return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return value
  const [, year, month, day] = match
  return `${day}.${month}.${year}`
}
</script>

<template>
  <aside class="preview-pane" aria-label="Dokumentvorschau">
    <div v-if="documentId == null" class="pane-empty">
      <i class="pi pi-file" />
      <p>Kein Dokument ausgewählt.</p>
    </div>

    <div v-else-if="loading && !doc" class="pane-empty">
      <ProgressSpinner style="width: 38px; height: 38px" />
    </div>

    <Message v-else-if="error" severity="error" :closable="false">{{ error }}</Message>

    <template v-else-if="doc">
      <header class="pane-head">
        <h2 class="pane-title">{{ doc.title || doc.original_filename }}</h2>
        <Tag :severity="statusSeverity(doc.status)" :value="statusLabel(doc.status)" />
        <Button
          icon="pi pi-angle-double-down"
          label="Details"
          size="small"
          text
          severity="secondary"
          v-tooltip.bottom="'Zu den Angaben unter der Vorschau springen'"
          @click="scrollToDetails"
        />
        <Button
          icon="pi pi-arrow-up-right"
          label="Öffnen"
          size="small"
          text
          v-tooltip.bottom="'Vollständige Detailansicht — dort wird bearbeitet'"
          @click="openFullDetail"
        />
      </header>

      <div ref="paneBody" class="pane-body">
        <div class="pane-pdf">
          <PdfViewer :data="pdfData" :error-message="pdfError || null" />
        </div>

        <div ref="detailsAnchor" class="pane-details">
          <div class="pane-meta">
            <span v-if="doc.sender"><i class="pi pi-building" /> {{ doc.sender }}</span>
            <span v-if="doc.doc_date"><i class="pi pi-calendar" /> {{ formatDate(doc.doc_date) }}</span>
            <span v-if="doc.category_slug"><i class="pi pi-folder-open" /> {{ doc.category_slug }}</span>
            <span v-if="doc.document_number"><i class="pi pi-hashtag" /> {{ doc.document_number }}</span>
            <span v-if="doc.tax_relevant" class="pane-tax">
              <i class="pi pi-calculator" /> Steuer{{ doc.tax_year ? ` ${doc.tax_year}` : '' }}
            </span>
          </div>

          <p v-if="doc.summary" class="pane-summary">{{ doc.summary }}</p>

          <div v-if="doc.collections.length > 0" class="pane-chips">
            <Chip v-for="c in doc.collections" :key="`c${c.id}`" :label="c.title" icon="pi pi-folder" />
          </div>
          <div v-if="doc.tags.length > 0" class="pane-chips">
            <Chip v-for="tag in doc.tags" :key="tag" :label="tag" />
          </div>

          <Message
            v-if="doc.status === 'failed' && doc.last_error"
            severity="error"
            :closable="false"
            icon="pi pi-times-circle"
          >
            {{ doc.last_error }}
          </Message>
        </div>
      </div>
    </template>

  </aside>
</template>

<style scoped>
.preview-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* The card's rounded border is the outer edge of everything in it; the body
     inside scrolls rather than spilling past it. */
  overflow: hidden;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
}
.pane-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  flex: 1 1 auto;
  color: var(--p-text-muted-color);
}
.pane-empty .pi-file {
  font-size: 2rem;
}
/* Stays put while the body below it scrolls — that is what makes the jump
   button worth having on a document of many pages. */
.pane-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.pane-title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Preview first, metadata under it — the order the full detail view uses when
   it has one column. The viewer therefore grows to its natural height and
   this element, not the viewer, owns the scrollbar. */
.pane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem 0.9rem;
}
.pane-pdf {
  display: flex;
  /* `flex: 0 0 auto` is load-bearing: as a shrinkable item in this column the
     viewer would be squeezed into whatever height was left and its pages
     compressed, instead of keeping its natural height and handing the
     overflow to `.pane-body`. That overflow is the point — it is what the
     metadata sits below and what the jump button skips. */
  flex: 0 0 auto;
  min-width: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  overflow: hidden;
}
.pane-details {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.pane-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.pane-meta i {
  margin-right: 0.2rem;
}
.pane-tax {
  color: var(--p-primary-color);
}
.pane-summary {
  margin: 0;
  font-size: 0.86rem;
  color: var(--p-text-color);
}
.pane-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.pane-chips :deep(.p-chip) {
  font-size: 0.74rem;
}
</style>
