<script setup lang="ts">
/**
 * One Sammelmappe: what is in it, in which order, and what comes out.
 *
 * Three decisions live here and nowhere else:
 *   - the order of the documents, which is the order of the PDF;
 *   - which documents and which of their pages are switched off — kept per
 *     membership, so the same document can be whole in one folder and trimmed
 *     in another;
 *   - the export, which is built on the server on demand and never stored.
 *
 * The PDF is fetched into a `File` first and shared from a *later* tap. iOS
 * revokes the transient activation across an `await`, so a share started
 * before the bytes are in hand is rejected — the same two-step the recap
 * video export uses (see utils/shareFile).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import CollectionPageSelector from '../components/documents/CollectionPageSelector.vue'
import {
  collectionPdfFilename,
  fetchCollectionPdf,
  getCollection,
  removeCollectionDocument,
  reorderCollection,
  updateCollection,
  updateCollectionItem,
  type DocumentCollectionDetail,
  type DocumentCollectionItem,
} from '../api/collections'
import { canShareFiles, shareFile, triggerDownload } from '../utils/shareFile'

const route = useRoute()
const router = useRouter()

const collection = ref<DocumentCollectionDetail | null>(null)
const loading = ref(false)
const loadError = ref('')
const info = ref('')
const busy = ref(false)

const titleDraft = ref('')
const notesDraft = ref('')
const summaryDraft = ref('')

const pageSelectorOpen = ref(false)
const pageSelectorItem = ref<DocumentCollectionItem | null>(null)

/** Set once the export is built; cleared by any change to the folder. */
const exportFile = ref<File | null>(null)
const exportUrl = ref<string | null>(null)
const exportSkipped = ref(0)
const exporting = ref(false)

const collectionId = computed(() => Number(route.params.id))
const items = computed(() => collection.value?.items ?? [])
const includedCount = computed(() => items.value.filter((i) => i.included).length)
const dirtyTitle = computed(
  () => !!collection.value && titleDraft.value.trim() !== collection.value.title,
)
const dirtyNotes = computed(
  () => !!collection.value && notesDraft.value !== (collection.value.notes ?? ''),
)
const dirtySummary = computed(
  () => !!collection.value && summaryDraft.value !== (collection.value.summary ?? ''),
)

watch(collectionId, () => void load())

function apply(detail: DocumentCollectionDetail) {
  collection.value = detail
  titleDraft.value = detail.title
  notesDraft.value = detail.notes ?? ''
  summaryDraft.value = detail.summary ?? ''
  discardExport()
}

/** A built PDF describes the folder as it was; any change invalidates it. */
function discardExport() {
  if (exportUrl.value) URL.revokeObjectURL(exportUrl.value)
  exportUrl.value = null
  exportFile.value = null
  exportSkipped.value = 0
}

async function load() {
  if (!Number.isFinite(collectionId.value)) return
  loading.value = true
  loadError.value = ''
  try {
    apply(await getCollection(collectionId.value))
  } catch (err: any) {
    loadError.value = err?.message ?? 'Sammelmappe konnte nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

async function run(fn: () => Promise<DocumentCollectionDetail>) {
  if (busy.value) return
  busy.value = true
  loadError.value = ''
  try {
    apply(await fn())
  } catch (err: any) {
    loadError.value = err?.message ?? 'Änderung fehlgeschlagen.'
  } finally {
    busy.value = false
  }
}

function saveTitle() {
  const title = titleDraft.value.trim()
  if (!title || !dirtyTitle.value) return
  void run(() => updateCollection(collectionId.value, { title }))
}

function saveNotes() {
  if (!dirtyNotes.value) return
  void run(() => updateCollection(collectionId.value, { notes: notesDraft.value.trim() || null }))
}

function saveSummary() {
  if (!dirtySummary.value) return
  void run(() =>
    updateCollection(collectionId.value, { summary: summaryDraft.value.trim() || null }),
  )
}

/** Hand the summary back to the model: clearing it re-stales the collection. */
function regenerateSummary() {
  void run(async () => {
    await updateCollection(collectionId.value, { summary: null })
    const detail = await getCollection(collectionId.value)
    info.value = 'Zusammenfassung wird im Hintergrund neu erzeugt.'
    return detail
  })
}

function setOption(patch: { include_cover?: boolean; include_toc?: boolean; include_summary?: boolean }) {
  void run(() => updateCollection(collectionId.value, patch))
}

function move(item: DocumentCollectionItem, delta: number) {
  const order = items.value.map((i) => i.document_id)
  const from = order.indexOf(item.document_id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return
  order.splice(to, 0, ...order.splice(from, 1))
  void run(() => reorderCollection(collectionId.value, order))
}

function toggleIncluded(item: DocumentCollectionItem, included: boolean) {
  void run(() => updateCollectionItem(collectionId.value, item.document_id, { included }))
}

function remove(item: DocumentCollectionItem) {
  void run(() => removeCollectionDocument(collectionId.value, item.document_id))
}

function openPageSelector(item: DocumentCollectionItem) {
  pageSelectorItem.value = item
  pageSelectorOpen.value = true
}

function savePageSelection(excludedPages: number[]) {
  const item = pageSelectorItem.value
  if (!item) return
  void run(() =>
    updateCollectionItem(collectionId.value, item.document_id, { excluded_pages: excludedPages }),
  )
}

function openDocument(item: DocumentCollectionItem) {
  router.push({ name: 'dokumente-detail', params: { id: item.document_id } })
}

async function buildExport() {
  if (!collection.value || exporting.value) return
  exporting.value = true
  loadError.value = ''
  try {
    const result = await fetchCollectionPdf(collectionId.value, collection.value.title)
    exportFile.value = result.file
    exportUrl.value = result.url
    exportSkipped.value = result.skipped
  } catch (err: any) {
    loadError.value = err?.message ?? 'PDF konnte nicht erzeugt werden.'
  } finally {
    exporting.value = false
  }
}

/**
 * Must stay synchronous up to `shareFile` — the File is already in hand, and
 * awaiting anything here would cost iOS's transient activation.
 */
async function shareExport() {
  const file = exportFile.value
  const url = exportUrl.value
  if (!file || !url) return
  await shareFile(file, url)
}

function downloadExport() {
  if (!exportUrl.value || !collection.value) return
  triggerDownload(exportUrl.value, collectionPdfFilename(collection.value.title))
}

function pageHint(item: DocumentCollectionItem): string {
  if (item.excluded_pages.length === 0) {
    return item.pages_total ? `${item.pages_total} Seiten` : 'alle Seiten'
  }
  const kept = item.pages_total ? item.pages_total - item.excluded_pages.length : null
  return kept != null
    ? `${kept} von ${item.pages_total} Seiten`
    : `${item.excluded_pages.length} Seiten abgewählt`
}

onMounted(load)
</script>

<template>
  <div class="collection-view">
    <header class="cd-header">
      <Button
        icon="pi pi-arrow-left"
        text
        rounded
        aria-label="Zurück zu den Sammelmappen"
        @click="router.push({ name: 'dokumente-mappen' })"
      />
      <InputText
        v-model="titleDraft"
        class="cd-title-input"
        placeholder="Titel der Sammelmappe"
        @blur="saveTitle"
        @keyup.enter="saveTitle"
      />
      <Tag
        v-if="collection?.visibility === 'group'"
        value="Gruppe"
        icon="pi pi-users"
        severity="info"
      />
    </header>

    <Message v-if="info" severity="success" closable @close="info = ''">{{ info }}</Message>
    <Message v-if="loadError" severity="error" closable @close="loadError = ''">
      {{ loadError }}
    </Message>

    <section class="cd-panel">
      <label for="cd-notes">Notiz</label>
      <Textarea
        id="cd-notes"
        v-model="notesDraft"
        rows="2"
        auto-resize
        placeholder="Erscheint unter dem Titel auf dem Deckblatt."
        @blur="saveNotes"
      />
    </section>

    <section class="cd-panel">
      <div class="cd-panel-head">
        <label for="cd-summary">Zusammenfassung über alle Dokumente</label>
        <div class="cd-panel-actions">
          <Tag
            v-if="collection?.summary_stale && (collection?.item_count ?? 0) > 0"
            value="wird erstellt"
            severity="secondary"
          />
          <Button
            icon="pi pi-sparkles"
            label="Neu erzeugen"
            text
            size="small"
            :disabled="busy || (collection?.item_count ?? 0) === 0"
            @click="regenerateSummary"
          />
        </div>
      </div>
      <Textarea
        id="cd-summary"
        v-model="summaryDraft"
        rows="4"
        auto-resize
        placeholder="Wird nach jeder Änderung automatisch erzeugt — und kann hier überschrieben werden."
        @blur="saveSummary"
      />
      <Message v-if="collection?.summary_error" severity="warn" :closable="false">
        Zusammenfassung fehlgeschlagen: {{ collection.summary_error }}
      </Message>
    </section>

    <section class="cd-panel">
      <span class="cd-panel-label">Im PDF enthalten</span>
      <div class="cd-options">
        <label>
          <Checkbox
            :model-value="collection?.include_cover ?? true"
            binary
            :disabled="busy"
            @update:model-value="setOption({ include_cover: $event })"
          />
          Deckblatt
        </label>
        <label>
          <Checkbox
            :model-value="collection?.include_toc ?? true"
            binary
            :disabled="busy"
            @update:model-value="setOption({ include_toc: $event })"
          />
          Inhaltsverzeichnis
        </label>
        <label>
          <Checkbox
            :model-value="collection?.include_summary ?? true"
            binary
            :disabled="busy"
            @update:model-value="setOption({ include_summary: $event })"
          />
          Zusammenfassung
        </label>
      </div>
    </section>

    <section>
      <h3 class="cd-list-title">
        Dokumente
        <span class="cd-list-count">({{ includedCount }} von {{ items.length }} im PDF)</span>
      </h3>

      <p v-if="!loading && items.length === 0" class="cd-empty">
        Noch keine Dokumente. Über „In Sammelmappe legen" aus der Dokumentenliste oder dem
        Arbeitskorb hinzufügen.
      </p>

      <ul class="cd-list">
        <li
          v-for="(item, index) in items"
          :key="item.document_id"
          class="cd-item"
          :class="{ 'cd-item--off': !item.included }"
        >
          <span class="cd-index">{{ index + 1 }}</span>
          <Checkbox
            :model-value="item.included"
            binary
            :disabled="busy"
            :aria-label="`Dokument ${index + 1} im PDF`"
            @update:model-value="toggleIncluded(item, $event)"
          />
          <button type="button" class="cd-thumb" @click="openDocument(item)">
            <DocumentThumbnail
              :id="item.document_id"
              :alt="item.title ?? item.original_filename"
            />
          </button>
          <div class="cd-body" @click="openDocument(item)">
            <span class="cd-name">{{ item.title || item.original_filename }}</span>
            <div class="cd-meta">
              <span v-if="item.sender"><i class="pi pi-building" /> {{ item.sender }}</span>
              <span v-if="item.doc_date"><i class="pi pi-calendar" /> {{ item.doc_date }}</span>
              <span :class="{ 'cd-pages--trimmed': item.excluded_pages.length > 0 }">
                <i class="pi pi-file" /> {{ pageHint(item) }}
              </span>
            </div>
          </div>
          <div class="cd-actions">
            <Button
              icon="pi pi-chevron-up"
              text
              rounded
              size="small"
              aria-label="Nach oben"
              :disabled="busy || index === 0"
              @click="move(item, -1)"
            />
            <Button
              icon="pi pi-chevron-down"
              text
              rounded
              size="small"
              aria-label="Nach unten"
              :disabled="busy || index === items.length - 1"
              @click="move(item, 1)"
            />
            <Button
              icon="pi pi-clone"
              text
              rounded
              size="small"
              aria-label="Seiten wählen"
              :disabled="busy"
              @click="openPageSelector(item)"
            />
            <Button
              icon="pi pi-times"
              text
              rounded
              size="small"
              severity="danger"
              aria-label="Aus der Mappe entfernen"
              :disabled="busy"
              @click="remove(item)"
            />
          </div>
        </li>
      </ul>
    </section>

    <section class="cd-export">
      <Button
        v-if="!exportFile"
        icon="pi pi-file-pdf"
        label="PDF erzeugen"
        :loading="exporting"
        :disabled="includedCount === 0 && !(collection?.include_cover ?? true)"
        @click="buildExport"
      />
      <template v-else>
        <Button
          :icon="canShareFiles() ? 'pi pi-share-alt' : 'pi pi-download'"
          :label="canShareFiles() ? 'PDF teilen' : 'PDF speichern'"
          @click="shareExport"
        />
        <Button
          v-if="canShareFiles()"
          icon="pi pi-download"
          label="Speichern"
          text
          severity="secondary"
          @click="downloadExport"
        />
        <Button icon="pi pi-refresh" label="Neu erzeugen" text @click="buildExport" />
      </template>
    </section>

    <Message v-if="exportSkipped > 0" severity="warn" :closable="false">
      {{ exportSkipped }}
      {{ exportSkipped === 1 ? 'Dokument konnte' : 'Dokumente konnten' }} nicht übernommen werden
      (Datei fehlt, alle Seiten abgewählt oder nicht sichtbar).
    </Message>

    <CollectionPageSelector
      v-if="pageSelectorItem"
      v-model:visible="pageSelectorOpen"
      :document-id="pageSelectorItem.document_id"
      :title="pageSelectorItem.title || pageSelectorItem.original_filename"
      :excluded-pages="pageSelectorItem.excluded_pages"
      @save="savePageSelection"
    />
  </div>
</template>

<style scoped>
.collection-view {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.cd-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cd-title-input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1.15rem;
  font-weight: 600;
}
.cd-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 12px 14px;
}
.cd-panel label,
.cd-panel-label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.cd-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.cd-panel-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cd-options {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}
.cd-options label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.9rem;
  color: var(--p-text-color);
}
.cd-list-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 8px;
}
.cd-list-count {
  font-weight: 400;
  color: var(--p-text-muted-color);
  margin-left: 6px;
  font-size: 0.85rem;
}
.cd-empty {
  color: var(--p-text-muted-color);
  font-size: 0.86rem;
  margin: 0;
}
.cd-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 8px 10px;
}
.cd-item--off {
  opacity: 0.55;
}
.cd-index {
  flex: 0 0 auto;
  width: 20px;
  text-align: right;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.cd-thumb {
  flex: 0 0 44px;
  width: 44px;
  height: 58px;
  border: 0;
  padding: 0;
  background: var(--p-content-hover-background);
  border-radius: 5px;
  overflow: hidden;
  cursor: pointer;
}
.cd-thumb :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cd-body {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}
.cd-name {
  font-weight: 600;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 3px;
  color: var(--p-text-muted-color);
  font-size: 0.78rem;
}
.cd-meta i {
  margin-right: 3px;
}
.cd-pages--trimmed {
  color: var(--p-primary-color);
  font-weight: 600;
}
.cd-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}
.cd-export {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
}
</style>
