<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputNumber from 'primevue/inputnumber'
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
  listTaxSectionsCatalog,
  reclassifyDocument,
  updateDocument,
  updateDocumentTax,
  updateDocumentVisibility,
  listGroups,
  type DocumentCategory,
  type DocumentDetail,
  type DocumentStatus,
  type DocumentVisibility,
  type GroupSummary,
  type TaxSectionCatalogEntry,
  type TaxSectionGroup,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { useRealtimeEvent } from '../composables/useRealtime'
import PdfViewer from '../components/PdfViewer.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const docId = computed(() => parseInt(route.params.id as string, 10))

const doc = ref<DocumentDetail | null>(null)
const categories = ref<DocumentCategory[]>([])
const groups = ref<GroupSummary[]>([])
const taxCatalog = ref<TaxSectionCatalogEntry[]>([])
const loading = ref(true)
const saving = ref(false)
const savingTax = ref(false)
const editingTax = ref(false)
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
  visibility: 'private' as DocumentVisibility,
  group_id: null as number | null,
})

const taxForm = ref({
  tax_relevant: false,
  tax_year: null as number | null,
  sections: new Set<string>(),
})

const TAX_GROUP_LABELS: Record<TaxSectionGroup, string> = {
  einkuenfte: 'Einkünfte',
  abzuege: 'Abzüge',
  bescheid: 'Bescheide',
  rahmen: 'Stammdaten',
}

const taxCatalogByGroup = computed(() => {
  const order: TaxSectionGroup[] = ['einkuenfte', 'abzuege', 'bescheid', 'rahmen']
  return order
    .map((g) => ({
      group: g,
      label: TAX_GROUP_LABELS[g],
      items: taxCatalog.value.filter((s) => s.group === g),
    }))
    .filter((b) => b.items.length > 0)
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
    const [detail, cats, taxCats, houseItems] = await Promise.all([
      getDocument(docId.value),
      listDocumentCategories(),
      // Catalog is static-ish — a fresh fetch per detail view is fine and
      // means new sections appear without a hard reload.
      listTaxSectionsCatalog(),
      listGroups(),
    ])
    doc.value = detail
    categories.value = cats.items
    taxCatalog.value = taxCats.items
    groups.value = houseItems.items
    resetForm()
    resetTaxForm()
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
    visibility: doc.value.visibility,
    group_id: doc.value.group_id,
  }
}

function resetTaxForm() {
  if (!doc.value) return
  taxForm.value = {
    tax_relevant: doc.value.tax_relevant,
    tax_year: doc.value.tax_year,
    sections: new Set(doc.value.tax_sections.map((s) => s.slug)),
  }
  editingTax.value = false
}

function toggleTaxSection(slug: string, checked: boolean) {
  const next = new Set(taxForm.value.sections)
  if (checked) next.add(slug)
  else next.delete(slug)
  taxForm.value.sections = next
}

async function saveTax() {
  if (!doc.value) return
  savingTax.value = true
  error.value = ''
  info.value = ''
  try {
    if (taxForm.value.tax_relevant) {
      if (taxForm.value.tax_year == null) {
        throw new Error('Bitte ein Steuerjahr auswählen.')
      }
      if (taxForm.value.sections.size === 0) {
        throw new Error('Bitte mindestens eine Steuer-Sektion auswählen.')
      }
    }
    const updated = await updateDocumentTax(doc.value.id, {
      tax_relevant: taxForm.value.tax_relevant,
      tax_year: taxForm.value.tax_relevant ? taxForm.value.tax_year : null,
      tax_sections: taxForm.value.tax_relevant
        ? Array.from(taxForm.value.sections)
        : [],
    })
    doc.value = updated
    resetTaxForm()
    info.value = 'Steuer-Zuordnung gespeichert.'
  } catch (err: any) {
    error.value = err.message || 'Speichern der Steuer-Zuordnung fehlgeschlagen'
  } finally {
    savingTax.value = false
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

    // Parallel save of basic metadata and visibility
    const tasks: Promise<any>[] = [
      updateDocument(doc.value.id, {
        title: form.value.title.trim() || null,
        doc_date: form.value.doc_date.trim() || null,
        sender: form.value.sender.trim() || null,
        summary: form.value.summary.trim() || null,
        category_slug: form.value.category_slug,
        tags,
      })
    ]

    const visibilityChanged = form.value.visibility !== doc.value.visibility ||
                               form.value.group_id !== doc.value.group_id

    if (visibilityChanged) {
      tasks.push(updateDocumentVisibility(doc.value.id, {
        visibility: form.value.visibility,
        group_id: form.value.visibility === 'group' ? form.value.group_id : null
      }))
    }

    const results = await Promise.all(tasks)
    doc.value = results[results.length - 1]
    resetForm()
    info.value = 'Änderungen gespeichert.'
  } catch (err: any) {
    error.value = err.message || 'Speichern fehlgeschlagen'
  } finally {
    saving.value = false
  }
}

async function onReclassify(options: { forceOcr?: boolean } = {}) {
  if (!doc.value) return
  saving.value = true
  error.value = ''
  info.value = ''
  try {
    await reclassifyDocument(doc.value.id, options)
    info.value = options.forceOcr
      ? 'OCR wurde erzwungen — Neuanalyse läuft.'
      : 'KI-Neuanalyse wurde gestartet.'
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

/**
 * "Zurück" should return to wherever the user came from — Steuer-View,
 * normal list, search result, etc. `window.history.state.back` is set by
 * vue-router whenever the previous entry was an SPA navigation; if it is
 * null (deep link or reload) we fall back to the document list.
 */
function goBack() {
  if (window.history.state?.back) {
    router.back()
  } else {
    router.push({ name: 'dokumente-list' })
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

// Reflect backend pipeline progress live. For intermediate stages we
// only update the status field so the tag re-renders; for terminal
// stages (ready / failed) the classifier has populated title,
// category, tax fields, etc. — reload the whole document so the
// editor sees the fresh values. If the user has unsaved edits a full
// reload would clobber them, so we skip reloading while a save is
// in progress.
useRealtimeEvent('documents', 'status.changed', (ev) => {
  if (!doc.value || doc.value.id !== Number(ev.resourceId)) return
  const payload = ev.payload as { status?: DocumentStatus; confidence?: number }
  if (!payload.status) return
  doc.value.status = payload.status
  if (typeof payload.confidence === 'number') {
    doc.value.classification_confidence = payload.confidence
  }
  if ((payload.status === 'ready' || payload.status === 'failed') && !saving.value && !savingTax.value) {
    load()
  }
})

onMounted(load)

onBeforeUnmount(() => {
  pdfData.value = null
})
</script>

<template>
  <div class="document-detail-view">
    <div class="header">
      <Button icon="pi pi-arrow-left" label="Zurück" text @click="goBack" />
      <div class="header-actions">
        <Button
          v-if="auth.hasPermission('documents.edit') && doc"
          icon="pi pi-refresh"
          label="Neu klassifizieren"
          text
          :loading="saving"
          @click="onReclassify()"
        />
        <Button
          v-if="auth.hasPermission('documents.edit') && doc"
          icon="pi pi-eye"
          label="OCR erzwingen"
          text
          :loading="saving"
          title="Text-Layer der PDF ignorieren und komplett per OCR neu einlesen (hilft bei Scans mit fehlenden Leerzeichen)."
          @click="onReclassify({ forceOcr: true })"
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

        <Message
          v-if="doc.status === 'failed' && doc.last_error"
          severity="error"
          :closable="false"
          icon="pi pi-times-circle"
        >
          <strong>Verarbeitung fehlgeschlagen:</strong> {{ doc.last_error }}
        </Message>

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

          <div v-if="auth.hasPermission('documents.edit')" class="visibility-section">
            <span class="label">Sichtbarkeit</span>
            <div class="visibility-options">
              <label class="radio-label">
                <input type="radio" v-model="form.visibility" value="private" />
                <span>Privat</span>
              </label>
              <label class="radio-label">
                <input type="radio" v-model="form.visibility" value="group" />
                <span>Gruppe</span>
              </label>
            </div>
            <div v-if="form.visibility === 'group'" class="group-select">
              <Select
                v-model="form.group_id"
                :options="groups"
                optionLabel="name"
                optionValue="id"
                placeholder="Gruppe auswählen"
                :disabled="!auth.hasPermission('documents.edit')"
              />
              <p v-if="groups.length === 0" class="hint">Du gehörst noch keiner Gruppe an.</p>
            </div>
          </div>

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

        <section class="tax-card">
          <div class="tax-card-header">
            <h2 class="tax-card-title">
              <i class="pi pi-receipt" /> Steuer
            </h2>
            <div class="tax-badges">
              <Tag
                v-if="doc.tax_relevant"
                severity="success"
                value="Steuerrelevant"
              />
              <Tag
                v-else
                severity="secondary"
                value="Nicht steuerrelevant"
              />
              <Tag
                v-if="doc.tax_reviewed"
                severity="info"
                value="Manuell bestätigt"
                v-tooltip.bottom="'Diese Werte wurden vom Nutzer bestätigt und werden bei Neuanalysen nicht überschrieben.'"
              />
            </div>
          </div>

          <div v-if="!editingTax" class="tax-view-mode">
            <div v-if="doc.tax_relevant && doc.tax_year" class="tax-info-row">
              <span class="label">Steuerjahr</span>
              <span>{{ doc.tax_year }}</span>
            </div>
            <div
              v-if="doc.tax_relevant && !doc.tax_reviewed && doc.tax_year_confidence != null"
              class="tax-info-row"
            >
              <span class="label">Jahr-Konfidenz</span>
              <span>{{ (doc.tax_year_confidence * 100).toFixed(0) }}%</span>
            </div>
            <div v-if="doc.tax_sections.length > 0" class="tax-sections-view">
              <span class="label">Zugeordnete Sektionen</span>
              <div class="tax-sections-list">
                <Chip
                  v-for="s in doc.tax_sections"
                  :key="s.slug"
                  :label="
                    s.name +
                    (s.source === 'ai' && s.confidence != null
                      ? ` · ${Math.round(s.confidence * 100)}%`
                      : '')
                  "
                  :icon="s.source === 'user' ? 'pi pi-user-edit' : 'pi pi-sparkles'"
                  :class="['tax-section-chip', `tax-section-chip--${s.source}`]"
                />
              </div>
            </div>
            <div v-else-if="!doc.tax_relevant" class="tax-empty-hint">
              Dieses Dokument wird nicht für die Steuererklärung benötigt.
            </div>
            <Button
              v-if="auth.hasPermission('documents.edit')"
              icon="pi pi-pencil"
              label="Bearbeiten"
              text
              size="small"
              @click="editingTax = true"
            />
          </div>

          <div v-else class="tax-edit-mode">
            <label class="tax-toggle-row">
              <Checkbox v-model="taxForm.tax_relevant" :binary="true" />
              <span>Dokument ist steuerrelevant</span>
            </label>

            <div v-if="taxForm.tax_relevant" class="tax-edit-fields">
              <label>
                <span class="label">Steuerjahr</span>
                <InputNumber
                  v-model="taxForm.tax_year"
                  :min="2000"
                  :max="2100"
                  :useGrouping="false"
                  showButtons
                  placeholder="z. B. 2025"
                />
              </label>

              <div class="tax-sections-edit">
                <span class="label">Sektionen der Steuererklärung</span>
                <div
                  v-for="group in taxCatalogByGroup"
                  :key="group.group"
                  class="tax-section-group"
                >
                  <div class="tax-section-group-label">{{ group.label }}</div>
                  <label
                    v-for="sec in group.items"
                    :key="sec.slug"
                    class="tax-section-option"
                    :title="sec.hint"
                  >
                    <Checkbox
                      :modelValue="taxForm.sections.has(sec.slug)"
                      :binary="true"
                      @update:modelValue="(v: boolean) => toggleTaxSection(sec.slug, v)"
                    />
                    <span>{{ sec.name }}</span>
                  </label>
                </div>
              </div>
            </div>

            <div class="save-row">
              <Button label="Abbrechen" text size="small" @click="resetTaxForm" />
              <Button
                label="Speichern"
                icon="pi pi-check"
                size="small"
                :loading="savingTax"
                @click="saveTax"
              />
            </div>
          </div>
        </section>

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
}
/* On wide viewports the form sits next to the PDF, so we constrain the
   view to the viewport and let each pane scroll independently. On narrow
   viewports the panes stack vertically — a fixed-height container would
   leave the form fighting the PDF for a few hundred pixels at the bottom,
   so we fall back to natural page flow there. */
@media (min-width: 1000px) {
  .document-detail-view {
    height: calc(100vh - var(--menubar-height, 3.5rem));
  }
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
  overflow: hidden;
  display: flex;
  /* Mobile: keep the preview in view but cap it so the form below stays
     reachable. Desktop overrides this below. */
  height: 60dvh;
  min-height: 320px;
}

@media (min-width: 1000px) {
  .pdf-panel {
    height: auto;
    min-height: 500px;
  }
}

.meta-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-right: 0.25rem;
}

@media (min-width: 1000px) {
  /* Inner-scroll only when the page is constrained to the viewport. */
  .meta-panel { overflow-y: auto; }
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

.visibility-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--p-surface-ground);
  border-radius: 6px;
  border: 1px solid var(--p-content-border-color);
}
.visibility-options {
  display: flex;
  gap: 1.5rem;
}
.radio-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
  cursor: pointer;
}
.group-select {
  margin-top: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.hint {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  margin: 0;
}

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

.tax-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  background: color-mix(in srgb, var(--p-primary-color) 4%, transparent);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}
.tax-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.tax-card-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.tax-badges {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.tax-view-mode {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.tax-info-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.9rem;
}
.tax-sections-view {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.tax-sections-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.tax-section-chip.tax-section-chip--user {
  background: color-mix(in srgb, var(--p-green-500) 18%, transparent);
}
.tax-empty-hint {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
}

.tax-edit-mode {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.tax-toggle-row {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.tax-edit-fields {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.tax-sections-edit {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.tax-section-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  padding: 0.25rem 0;
}
.tax-section-group-label {
  width: 100%;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--p-primary-color);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tax-section-option {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
  cursor: pointer;
}
</style>
