<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Chip from 'primevue/chip'
import {
  deleteDocument,
  fetchDocumentBytes,
  getDocument,
  listDocumentCategories,
  reclassifyDocument,
  updateDocument,
  type DocumentCategory,
  type DocumentDetail,
  type DocumentStatus,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'
import PdfViewer from '../components/PdfViewer.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const docId = computed(() => parseInt(route.params.id as string, 10))

const doc = ref<DocumentDetail | null>(null)
const categories = ref<DocumentCategory[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const info = ref('')
const pdfData = ref<Uint8Array | null>(null)
const pdfError = ref('')

const form = ref({
  title: '' as string,
  doc_date: '' as string,
  sender: '' as string,
  summary: '' as string,
  category_slug: null as string | null,
  tagsText: '' as string,
})

const categoryOptions = computed(() => {
  const opts: Array<{ label: string; value: string | null }> = [{ label: '— keine —', value: null }]
  for (const c of categories.value) {
    const prefix = c.parent_id == null ? '' : '— '
    opts.push({ label: `${prefix}${c.name}`, value: c.slug })
  }
  return opts
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [detail, cats] = await Promise.all([
      getDocument(docId.value),
      listDocumentCategories(),
    ])
    doc.value = detail
    categories.value = cats.items
    resetForm()
    await loadPdf()
  } catch (err: any) {
    error.value = err.message || 'Dokument konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function loadPdf() {
  pdfData.value = null
  pdfError.value = ''
  try {
    pdfData.value = await fetchDocumentBytes(docId.value)
  } catch (err: any) {
    pdfError.value = err.message || 'PDF kann nicht geladen werden'
  }
}

function resetForm() {
  if (!doc.value) return
  form.value = {
    title: doc.value.title ?? '',
    doc_date: doc.value.doc_date ?? '',
    sender: doc.value.sender ?? '',
    summary: doc.value.summary ?? '',
    category_slug: doc.value.category_slug,
    tagsText: doc.value.tags.join(', '),
  }
}

async function save() {
  if (!doc.value) return
  saving.value = true
  error.value = ''
  info.value = ''
  try {
    const tags = form.value.tagsText
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    const updated = await updateDocument(doc.value.id, {
      title: form.value.title.trim() || null,
      doc_date: form.value.doc_date.trim() || null,
      sender: form.value.sender.trim() || null,
      summary: form.value.summary.trim() || null,
      category_slug: form.value.category_slug,
      tags,
    })
    doc.value = updated
    resetForm()
    info.value = 'Änderungen gespeichert.'
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen'
  } finally {
    saving.value = false
  }
}

async function onReclassify() {
  if (!doc.value) return
  saving.value = true
  error.value = ''
  info.value = ''
  try {
    await reclassifyDocument(doc.value.id)
    info.value = 'KI-Neuanalyse wurde gestartet.'
    // Refresh after a short delay so status updates become visible.
    setTimeout(load, 1500)
  } catch (err: any) {
    error.value = err.message || 'Neuanalyse konnte nicht gestartet werden'
  } finally {
    saving.value = false
  }
}

async function onDelete() {
  if (!doc.value) return
  if (!window.confirm('Dokument wirklich endgültig löschen?')) return
  try {
    await deleteDocument(doc.value.id)
    router.push({ name: 'dokumente-list' })
  } catch (err: any) {
    error.value = err.message || 'Löschen fehlgeschlagen'
  }
}

function statusSeverity(status: DocumentStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (status) {
    case 'ready': return 'success'
    case 'failed': return 'danger'
    case 'pending': return 'secondary'
    case 'extracting':
    case 'classifying':
      return 'info'
    default: return 'secondary'
  }
}

function statusLabel(status: DocumentStatus): string {
  switch (status) {
    case 'ready': return 'Fertig'
    case 'failed': return 'Fehler'
    case 'pending': return 'Warteschlange'
    case 'extracting': return 'Text-Extraktion'
    case 'classifying': return 'KI-Analyse'
    default: return status
  }
}

watch(() => route.params.id, (newId, oldId) => {
  if (newId !== oldId) load()
})

onMounted(load)

onBeforeUnmount(() => {
  pdfData.value = null
})
</script>

<template>
  <div class="document-detail-view">
    <div class="header">
      <Button icon="pi pi-arrow-left" label="Zurück" text @click="router.push({ name: 'dokumente-list' })" />
      <div class="header-actions">
        <Button
          v-if="auth.hasPermission('documents.edit') && doc"
          icon="pi pi-refresh"
          label="Neu klassifizieren"
          text
          :loading="saving"
          @click="onReclassify"
        />
        <Button
          v-if="auth.hasPermission('documents.delete') && doc"
          icon="pi pi-trash"
          severity="danger"
          text
          label="Löschen"
          @click="onDelete"
        />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Dokument wird geladen…
    </div>

    <div v-else-if="doc" class="detail-grid">
      <div class="pdf-panel">
        <PdfViewer :data="pdfData" :error-message="pdfError || null" />
      </div>

      <div class="meta-panel">
        <div class="meta-top">
          <h1 class="doc-title">{{ doc.title || doc.original_filename }}</h1>
          <Tag :severity="statusSeverity(doc.status)" :value="statusLabel(doc.status)" />
        </div>

        <div class="meta-summary" v-if="doc.summary">
          <i class="pi pi-info-circle" />
          <span>{{ doc.summary }}</span>
        </div>

        <div class="meta-form">
          <label>
            <span class="label">Titel</span>
            <InputText v-model="form.title" :disabled="!auth.hasPermission('documents.edit')" />
          </label>
          <div class="meta-form-row">
            <label>
              <span class="label">Datum</span>
              <InputText
                v-model="form.doc_date"
                placeholder="YYYY-MM-DD"
                :disabled="!auth.hasPermission('documents.edit')"
              />
            </label>
            <label>
              <span class="label">Absender</span>
              <InputText v-model="form.sender" :disabled="!auth.hasPermission('documents.edit')" />
            </label>
          </div>
          <label>
            <span class="label">Kategorie</span>
            <Select
              v-model="form.category_slug"
              :options="categoryOptions"
              optionLabel="label"
              optionValue="value"
              :disabled="!auth.hasPermission('documents.edit')"
            />
          </label>
          <label>
            <span class="label">Tags (Komma-getrennt)</span>
            <InputText v-model="form.tagsText" :disabled="!auth.hasPermission('documents.edit')" />
          </label>
          <label>
            <span class="label">Zusammenfassung</span>
            <textarea
              v-model="form.summary"
              class="p-inputtextarea p-inputtext"
              rows="4"
              :disabled="!auth.hasPermission('documents.edit')"
            />
          </label>

          <div v-if="doc.tags.length > 0" class="current-tags">
            <Chip v-for="t in doc.tags" :key="t" :label="t" />
          </div>

          <div v-if="auth.hasPermission('documents.edit')" class="save-row">
            <Button label="Zurücksetzen" text @click="resetForm" />
            <Button label="Speichern" icon="pi pi-check" :loading="saving" @click="save" />
          </div>
        </div>

        <div class="extra-info">
          <div><strong>Datei:</strong> {{ doc.original_filename }}</div>
          <div v-if="doc.classification_confidence != null">
            <strong>Konfidenz:</strong> {{ (doc.classification_confidence * 100).toFixed(0) }}%
          </div>
          <div v-if="doc.extracted_text_preview" class="text-preview">
            <strong>Text-Vorschau:</strong>
            <p>{{ doc.extracted_text_preview }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.document-detail-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  padding-inline: 0.5em;
  height: calc(100vh - var(--menubar-height, 3.5rem));
}
@media (min-width: 800px) { .document-detail-view { padding-inline: 1em; } }

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-actions { display: flex; gap: 0.25rem; }

.info-text { text-align: center; margin-top: 4rem; color: var(--p-text-muted-color); }

.detail-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}

@media (min-width: 1000px) {
  .detail-grid { grid-template-columns: 1.4fr 1fr; }
}

.pdf-panel {
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  min-height: 500px;
  overflow: hidden;
  display: flex;
}

.meta-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  padding-right: 0.25rem;
}

.meta-top {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
}
.doc-title { font-size: 1.25rem; font-weight: 600; flex: 1; min-width: 0; }

.meta-summary {
  display: flex;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
  border-radius: 6px;
  font-size: 0.9rem;
  line-height: 1.4;
}
.meta-summary i { color: var(--p-primary-color); flex-shrink: 0; margin-top: 0.15rem; }

.meta-form { display: flex; flex-direction: column; gap: 0.75rem; }
.meta-form label { display: flex; flex-direction: column; gap: 0.25rem; }
.meta-form-row {
  display: grid;
  gap: 0.5rem;
  grid-template-columns: 1fr 1fr;
}
.label { font-size: 0.85rem; color: var(--p-text-muted-color); }

.current-tags { display: flex; flex-wrap: wrap; gap: 0.25rem; }

.save-row {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.extra-info {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.text-preview p {
  margin: 0.25rem 0 0;
  padding: 0.5rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  max-height: 180px;
  overflow-y: auto;
}
</style>
