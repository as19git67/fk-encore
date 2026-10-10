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
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import PageLayout from '../components/layout/PageLayout.vue'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import CollectionPageSelector from '../components/documents/CollectionPageSelector.vue'
import {
  applyCollectionRule,
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
import { listCorrespondents, type CorrespondentFacet } from '../api/documents'
import { canShareFiles, shareFile, triggerDownload } from '../utils/shareFile'
import { useModuleBack } from '../composables/useModuleBack'
import { useDragReorder } from '../composables/useDragReorder'

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

/**
 * "Zurück" returns to wherever the folder was opened from — the document list
 * at the row and scroll position it was left at, the Sammelmappen list, or a
 * document detail. `useModuleBack` uses browser history whenever the previous
 * entry is under `/dokumente`, so the list restores itself the way it already
 * does for a document; only a deep link or a reload falls back to the folder
 * list, so back never leaves the module.
 */
const { goBack } = useModuleBack('/dokumente', 'dokumente-mappen')

// ─── Dossier rule (#1480) ───────────────────────────────────────────────────
// Drafted as text and saved as a whole: the server normalises the parts and
// applies the rule to the corpus right away, so the list below moves on save.
const ruleCorrespondent = ref<string | null>(null)
const ruleRefsText = ref('')
const ruleFolder = ref('')
const correspondents = ref<CorrespondentFacet[]>([])
const ruleResult = ref<{ added: number; removed: number } | null>(null)
const isDossier = computed(() => collection.value?.kind === 'dossier')
const ruleJoinedCount = computed(() => items.value.filter((i) => i.joined_by === 'rule').length)
const dirtyRule = computed(() => {
  const r = collection.value?.rule
  return (
    (ruleCorrespondent.value ?? null) !== (r?.correspondent_slug ?? null) ||
    ruleRefsText.value.trim() !== (r?.reference_numbers ?? []).join(', ') ||
    ruleFolder.value.trim() !== (r?.source_folder_prefix ?? '')
  )
})
const ruleDraftEmpty = computed(
  () => !ruleCorrespondent.value && !ruleRefsText.value.trim() && !ruleFolder.value.trim(),
)
function applyRuleDraft(detail: DocumentCollectionDetail) {
  ruleCorrespondent.value = detail.rule?.correspondent_slug ?? null
  ruleRefsText.value = (detail.rule?.reference_numbers ?? []).join(', ')
  ruleFolder.value = detail.rule?.source_folder_prefix ?? ''
}
function ruleInput() {
  return {
    correspondent_slug: ruleCorrespondent.value,
    reference_numbers: ruleRefsText.value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean),
    source_folder_prefix: ruleFolder.value.trim() || null,
  }
}
function saveRule() {
  if (ruleDraftEmpty.value) return
  ruleResult.value = null
  void run(() => updateCollection(collectionId.value, { kind: 'dossier', rule: ruleInput() }))
}
function stopRule() {
  ruleResult.value = null
  void run(() => updateCollection(collectionId.value, { kind: 'manual' }))
}
async function runRuleNow() {
  busy.value = true
  loadError.value = ''
  try {
    ruleResult.value = await applyCollectionRule(collectionId.value)
    await load()
  } catch (err: any) {
    loadError.value = err?.message ?? 'Regel konnte nicht angewendet werden.'
  } finally {
    busy.value = false
  }
}
async function loadCorrespondents() {
  try {
    correspondents.value = (await listCorrespondents()).items
  } catch {
    correspondents.value = []
  }
}
const correspondentOptions = computed(() => [
  { label: 'Beliebig', value: null as string | null },
  ...correspondents.value.map((c) => ({ label: `${c.display} (${c.count})`, value: c.slug as string | null })),
])

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
  applyRuleDraft(detail)
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

/**
 * The order is set by dragging the grip (or ArrowUp/ArrowDown on it). The
 * list shows the would-be order while dragging and saves once on release.
 */
const {
  ordered: orderedItems,
  draggingKey,
  onGripPointerDown,
  onGripKeydown,
} = useDragReorder({
  items,
  keyOf: (item) => item.document_id,
  commit: (keys) => run(() => reorderCollection(collectionId.value, keys as number[])),
  disabled: busy,
})

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

/**
 * `mappe` tells the detail page which folder it was opened from, so it can
 * step to the previous and next document of this folder directly.
 */
function openDocument(item: DocumentCollectionItem) {
  router.push({
    name: 'dokumente-detail',
    params: { id: item.document_id },
    query: { mappe: String(collectionId.value) },
  })
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

onMounted(() => {
  void load()
  void loadCorrespondents()
})
</script>

<template>
  <PageLayout :title="collection?.title || 'Sammelmappe'" width="normal" :ready="!loading">
    <template #actions>
      <Button
        icon="pi pi-arrow-left"
        text
        rounded
        aria-label="Zurück"
        @click="goBack"
      />
    </template>

    <template #notice>
      <Message v-if="info" severity="success" closable @close="info = ''">{{ info }}</Message>
      <Message v-if="loadError" severity="error" closable @close="loadError = ''">
        {{ loadError }}
      </Message>
    </template>

    <div class="content">
    <div class="cd-title-row">
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
    </div>

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

    <!-- Dossier rule (#1480): what joins this folder by itself. -->
    <section class="cd-panel">
      <div class="cd-panel-head">
        <span class="cd-panel-label">
          <i class="pi pi-bolt" aria-hidden="true" />
          Akte: Dokumente nach Regel aufnehmen
        </span>
        <div class="cd-panel-actions">
          <Tag v-if="isDossier" :value="`${ruleJoinedCount} per Regel`" severity="secondary" />
          <Button
            v-if="isDossier"
            icon="pi pi-refresh"
            label="Regel jetzt anwenden"
            text
            size="small"
            :disabled="busy || dirtyRule"
            @click="runRuleNow"
          />
        </div>
      </div>
      <p class="cd-rule-hint">
        Ein Dokument tritt bei, wenn es aus dem Herkunftsordner stammt oder Korrespondent und
        Referenznummer passen. Was die Regel aufnimmt, nimmt sie auch wieder heraus, wenn das
        Dokument nicht mehr passt; von Hand Hinzugefügtes und Entferntes bleibt, wie es ist.
      </p>
      <div class="cd-rule-fields">
        <label>
          <span>Korrespondent</span>
          <Select
            :model-value="ruleCorrespondent"
            :options="correspondentOptions"
            option-label="label"
            option-value="value"
            filter
            :disabled="busy"
            @update:model-value="(v: string | null) => (ruleCorrespondent = v)"
          />
        </label>
        <label>
          <span>Referenznummern (Komma-getrennt)</span>
          <InputText v-model="ruleRefsText" placeholder="AB 123456, 998877" :disabled="busy" />
        </label>
        <label>
          <span>Herkunftsordner (Präfix)</span>
          <InputText v-model="ruleFolder" placeholder="Versicherungen/Hausrat" :disabled="busy" />
        </label>
      </div>
      <div class="cd-rule-actions">
        <Button
          v-if="isDossier"
          label="Regel abschalten"
          severity="secondary"
          outlined
          size="small"
          :disabled="busy"
          @click="stopRule"
        />
        <Button
          :label="isDossier ? 'Regel speichern' : 'Als Akte mit dieser Regel führen'"
          icon="pi pi-check"
          size="small"
          :disabled="busy || ruleDraftEmpty || (isDossier && !dirtyRule)"
          @click="saveRule"
        />
      </div>
      <Message v-if="ruleResult" severity="info" :closable="true" @close="ruleResult = null">
        Regel angewendet: {{ ruleResult.added }} aufgenommen, {{ ruleResult.removed }} entfernt.
      </Message>
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

      <ul class="cd-list" data-reorder-list>
        <li
          v-for="(item, index) in orderedItems"
          :key="item.document_id"
          class="cd-item"
          :class="{
            'cd-item--off': !item.included,
            'cd-item--dragging': draggingKey === item.document_id,
          }"
          :data-reorder-key="item.document_id"
        >
          <button
            v-if="items.length > 1"
            type="button"
            class="cd-grip"
            :aria-label="`Dokument ${index + 1} verschieben (Pfeiltasten hoch/runter)`"
            v-tooltip.bottom="'Ziehen zum Verschieben'"
            :disabled="busy"
            @pointerdown="onGripPointerDown(item.document_id, $event)"
            @keydown="onGripKeydown(item.document_id, $event)"
          >
            <i class="pi pi-bars" aria-hidden="true" />
          </button>
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
            <span class="cd-name">
              {{ item.title || item.original_filename }}
              <Tag v-if="item.joined_by === 'rule'" value="per Regel" severity="secondary" class="cd-rule-tag" />
            </span>
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
    </div>

    <CollectionPageSelector
      v-if="pageSelectorItem"
      v-model:visible="pageSelectorOpen"
      :document-id="pageSelectorItem.document_id"
      :title="pageSelectorItem.title || pageSelectorItem.original_filename"
      :excluded-pages="pageSelectorItem.excluded_pages"
      @save="savePageSelection"
    />
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* Editable title (the h1 above shows the saved one). */
.cd-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cd-title-input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--text-xl);
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
  font-size: var(--text-md);
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
.cd-rule-hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.cd-rule-fields {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-2);
}
/* Three fields side by side from `md` up (768px, see useBreakpoint). */
@media (min-width: 768px) {
  .cd-rule-fields {
    grid-template-columns: 1fr 1fr 1fr;
  }
}
.cd-rule-fields label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.cd-rule-fields label > span {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.cd-rule-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.cd-rule-tag {
  margin-left: 0.4em;
  vertical-align: middle;
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
  font-size: var(--text-base);
  color: var(--p-text-color);
}
.cd-list-title {
  font-size: var(--text-lg);
  font-weight: 600;
  margin: 0 0 8px;
}
.cd-list-count {
  font-weight: 400;
  color: var(--p-text-muted-color);
  margin-left: 6px;
  font-size: var(--text-base);
}
.cd-empty {
  color: var(--p-text-muted-color);
  font-size: var(--text-base);
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
.cd-item--dragging {
  position: relative;
  z-index: 1;
  border-color: var(--p-primary-color);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
}
/* The grip owns its touches: without `touch-action: none` the browser would
   scroll the page instead of handing the finger to the drag. */
.cd-grip {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 40px;
  margin: 0 -4px 0 -4px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--p-text-muted-color);
  cursor: grab;
  touch-action: none;
}
.cd-grip:hover:not(:disabled) {
  background: var(--p-content-hover-background);
}
.cd-grip:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.cd-grip:disabled {
  cursor: default;
  opacity: 0.5;
}
.cd-item--dragging .cd-grip {
  cursor: grabbing;
  color: var(--p-primary-color);
}
.cd-index {
  flex: 0 0 auto;
  width: 20px;
  text-align: right;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
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
  font-size: var(--text-sm);
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
