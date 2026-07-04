<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import Drawer from 'primevue/drawer'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import MultiSelect from 'primevue/multiselect'
import SelectButton from 'primevue/selectbutton'
import TreeSelect from 'primevue/treeselect'
import type { TreeNode } from 'primevue/treenode'
import MultiSelectDialog from '../MultiSelectDialog.vue'
import { useDocSelectionStore } from '../../stores/documents/selection'
import {
  batchUpdateDocumentAttributes,
  batchUpdateDocumentSubjectPersons,
  batchUpdateDocumentTags,
  batchUpdateDocumentTax,
  listDocumentCategories,
  listSubjectPersons,
  listTaxSectionsCatalog,
  type DocumentCategory,
  type DocumentSummary,
  type SubjectPerson,
  type TaxSectionCatalogEntry,
} from '../../api/documents'
import { toLocalIsoDate } from '../../utils/dateFormat'
import { useAuthStore } from '../../stores/auth'

/**
 * Header indicator + slide-out drawer for the document basket (issue #736).
 *
 * The documents twin of the finance TxBasketIndicator: surfaces the current
 * selection regardless of which view created it, doubles as a navigation
 * list (clicking an entry opens the document), and applies batch operations
 * — tags, category, document date, tax metadata, Bezugspersonen — to every
 * document in the basket. Mounted from App.vue's navbar-end only while the
 * user is in the documents module.
 */

const router = useRouter()
const auth = useAuthStore()
const selectionStore = useDocSelectionStore()
const canEdit = computed(() => auth.hasPermission('documents.edit'))

const drawerVisible = ref(false)
const actionError = ref<string | null>(null)
const actionInfo = ref<string | null>(null)

const count = computed(() => selectionStore.count)
const items = computed(() => selectionStore.items)

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function openDocument(doc: DocumentSummary) {
  drawerVisible.value = false
  router.push({ name: 'dokumente-detail', params: { id: doc.id } })
}

function resetMessages() {
  actionError.value = null
  actionInfo.value = null
}

function reportDone(affected: number, what: string) {
  actionInfo.value = `${what} auf ${affected} Dokument${affected === 1 ? '' : 'e'} angewendet.`
}

function reportError(err: unknown) {
  actionError.value = err instanceof Error ? err.message : String(err)
}

// ─── Shared option sources (loaded lazily when a dialog opens) ───────────────

const categories = ref<DocumentCategory[]>([])
const taxSections = ref<TaxSectionCatalogEntry[]>([])
const subjectPersons = ref<SubjectPerson[]>([])

async function ensureCategories() {
  if (categories.value.length > 0) return
  categories.value = (await listDocumentCategories()).items
}
async function ensureTaxSections() {
  if (taxSections.value.length > 0) return
  taxSections.value = (await listTaxSectionsCatalog()).items
}
async function ensureSubjectPersons() {
  subjectPersons.value = (await listSubjectPersons()).items
}

/**
 * Flat category rows → nested TreeSelect nodes via `parent_id`, so the
 * drawer's category picker preserves the taxonomy (Finanzen › Steuern …)
 * instead of flattening every level into one list. `key` is the slug — the
 * value we send to the batch endpoint.
 */
const categoryTree = computed<TreeNode[]>(() => {
  const byId = new Map<number, TreeNode>()
  for (const c of categories.value) {
    byId.set(c.id, { key: c.slug, label: c.name, children: [] })
  }
  const roots: TreeNode[] = []
  for (const c of categories.value) {
    const node = byId.get(c.id)!
    const parent = c.parent_id != null ? byId.get(c.parent_id) : undefined
    if (parent) parent.children!.push(node)
    else roots.push(node)
  }
  // Drop empty children arrays so leaves don't render an expander toggle.
  const prune = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.children && n.children.length === 0) delete n.children
      else if (n.children) prune(n.children)
    }
  }
  prune(roots)
  return roots
})
const taxSectionOptions = computed(() =>
  taxSections.value.map((s) => ({ label: s.name, value: s.slug })),
)
const personOptions = computed(() =>
  subjectPersons.value.map((p) => ({
    label: `${p.full_name} (${p.relation_tag})`,
    value: p.id,
  })),
)

// ─── Tags ───────────────────────────────────────────────────────────────────

const tagDialogVisible = ref(false)
const savingTags = ref(false)
const sessionAddedTags = ref<string[]>([])

const allKnownTags = computed(() => {
  const seen = new Set<string>()
  for (const d of items.value) for (const t of d.tags) seen.add(t)
  for (const t of sessionAddedTags.value) seen.add(t)
  return [...seen].sort((a, b) => a.localeCompare(b))
})
const tagDialogItems = computed(() => allKnownTags.value.map((t) => ({ id: t, label: t })))
const tagInitialStates = computed<Map<string, boolean | null>>(() => {
  const out = new Map<string, boolean | null>()
  for (const tag of allKnownTags.value) {
    const n = items.value.filter((d) => d.tags.includes(tag)).length
    out.set(tag, n === 0 ? false : n === items.value.length ? true : null)
  }
  return out
})

function openTagDialog() {
  resetMessages()
  tagDialogVisible.value = true
}

function handleTagCreate(name: string) {
  const trimmed = name.trim().toLowerCase()
  if (trimmed && !sessionAddedTags.value.includes(trimmed)) {
    sessionAddedTags.value = [...sessionAddedTags.value, trimmed]
  }
}

async function handleTagSave(payload: { adds: string[]; removes: string[] }) {
  savingTags.value = true
  try {
    const res = await batchUpdateDocumentTags({
      document_ids: selectionStore.ids as number[],
      add: payload.adds,
      remove: payload.removes,
    })
    // Keep the basket snapshots in sync so the tristate stays truthful.
    for (const d of items.value) {
      d.tags = [
        ...new Set([...d.tags.filter((t) => !payload.removes.includes(t)), ...payload.adds]),
      ]
    }
    tagDialogVisible.value = false
    reportDone(res.affected_documents, 'Tags')
  } catch (err) {
    reportError(err)
  } finally {
    savingTags.value = false
  }
}

// ─── Category ───────────────────────────────────────────────────────────────

const categoryDialogVisible = ref(false)
// TreeSelect single-selection model is a `{ [key]: true }` map; the chosen
// category slug is its single key (empty = clear the category).
const categorySelection = ref<Record<string, boolean>>({})
const savingCategory = ref(false)

const categoryDraft = computed<string | null>(() => {
  const keys = Object.keys(categorySelection.value)
  return keys[0] ?? null
})

async function openCategoryDialog() {
  resetMessages()
  categorySelection.value = {}
  categoryDialogVisible.value = true
  await ensureCategories().catch(reportError)
}

async function saveCategory() {
  savingCategory.value = true
  try {
    const res = await batchUpdateDocumentAttributes({
      document_ids: selectionStore.ids as number[],
      category_slug: categoryDraft.value,
    })
    for (const d of items.value) d.category_slug = categoryDraft.value
    categoryDialogVisible.value = false
    reportDone(res.affected_documents, 'Kategorie')
  } catch (err) {
    reportError(err)
  } finally {
    savingCategory.value = false
  }
}

// ─── Document date ──────────────────────────────────────────────────────────

const dateDialogVisible = ref(false)
const dateDraft = ref<Date | null>(null)
const savingDate = ref(false)

function openDateDialog() {
  resetMessages()
  dateDraft.value = null
  dateDialogVisible.value = true
}

async function saveDate() {
  savingDate.value = true
  try {
    const iso = dateDraft.value ? toLocalIsoDate(dateDraft.value) : null
    const res = await batchUpdateDocumentAttributes({
      document_ids: selectionStore.ids as number[],
      doc_date: iso,
    })
    for (const d of items.value) d.doc_date = iso
    dateDialogVisible.value = false
    reportDone(res.affected_documents, 'Dokumentdatum')
  } catch (err) {
    reportError(err)
  } finally {
    savingDate.value = false
  }
}

// ─── Tax ────────────────────────────────────────────────────────────────────

const taxDialogVisible = ref(false)
const taxRelevantDraft = ref(true)
const taxYearDraft = ref<number | null>(new Date().getFullYear() - 1)
const taxSectionsDraft = ref<string[]>([])
const savingTax = ref(false)

async function openTaxDialog() {
  resetMessages()
  taxDialogVisible.value = true
  await ensureTaxSections().catch(reportError)
}

const taxSaveDisabled = computed(
  () =>
    taxRelevantDraft.value &&
    (taxYearDraft.value == null || taxSectionsDraft.value.length === 0),
)

async function saveTax() {
  savingTax.value = true
  try {
    const res = await batchUpdateDocumentTax({
      document_ids: selectionStore.ids as number[],
      tax_relevant: taxRelevantDraft.value,
      tax_year: taxRelevantDraft.value ? taxYearDraft.value : null,
      tax_sections: taxRelevantDraft.value ? taxSectionsDraft.value : [],
    })
    for (const d of items.value) {
      d.tax_relevant = taxRelevantDraft.value
      d.tax_year = taxRelevantDraft.value ? taxYearDraft.value : null
    }
    taxDialogVisible.value = false
    reportDone(res.affected_documents, 'Steuer-Metadaten')
  } catch (err) {
    reportError(err)
  } finally {
    savingTax.value = false
  }
}

// ─── Approve AI attribution (issue #635) ────────────────────────────────────

const approving = ref(false)
const newCount = computed(
  () => items.value.filter((d) => d.status === 'ready' && !d.attributes_reviewed).length,
)

/** Pin the attributes of every basket document — clears their "Neu" marker. */
async function approveAttribution() {
  approving.value = true
  resetMessages()
  try {
    const res = await batchUpdateDocumentAttributes({
      document_ids: selectionStore.ids as number[],
      attributes_reviewed: true,
    })
    for (const d of items.value) d.attributes_reviewed = true
    reportDone(res.affected_documents, 'Bestätigung')
  } catch (err) {
    reportError(err)
  } finally {
    approving.value = false
  }
}

// ─── Subject persons (Bezugspersonen) ───────────────────────────────────────

const personsDialogVisible = ref(false)
const personsMode = ref<'add' | 'remove'>('add')
const personsDraft = ref<number[]>([])
const savingPersons = ref(false)
const personsModeOptions = [
  { label: 'Hinzufügen', value: 'add' },
  { label: 'Entfernen', value: 'remove' },
]

async function openPersonsDialog() {
  resetMessages()
  personsMode.value = 'add'
  personsDraft.value = []
  personsDialogVisible.value = true
  await ensureSubjectPersons().catch(reportError)
}

async function savePersons() {
  savingPersons.value = true
  try {
    const res = await batchUpdateDocumentSubjectPersons({
      document_ids: selectionStore.ids as number[],
      ...(personsMode.value === 'add'
        ? { add_ids: personsDraft.value }
        : { remove_ids: personsDraft.value }),
    })
    personsDialogVisible.value = false
    reportDone(res.affected_documents, 'Bezugspersonen')
  } catch (err) {
    reportError(err)
  } finally {
    savingPersons.value = false
  }
}
</script>

<template>
  <div class="basket-indicator">
    <Button
      v-tooltip.bottom="count === 0 ? 'Basket (leer)' : `Basket · ${count} Dokument${count === 1 ? '' : 'e'}`"
      icon="pi pi-shopping-cart"
      severity="secondary"
      text
      rounded
      :badge="count > 0 ? String(count) : undefined"
      badge-severity="info"
      aria-label="Basket öffnen"
      class="basket-button"
      @click="drawerVisible = true"
    />

    <Drawer v-model:visible="drawerVisible" position="right" header="Basket" class="basket-drawer">
      <template #header>
        <div class="drawer-header">
          <span class="drawer-title">Basket</span>
          <span v-if="count > 0" class="drawer-count">{{ count }} Dokument{{ count === 1 ? '' : 'e' }}</span>
        </div>
      </template>

      <div v-if="count === 0" class="basket-empty">
        <i class="pi pi-shopping-cart basket-empty-icon" />
        <p>Noch keine Dokumente im Basket.</p>
        <p class="hint">
          Lege Dokumente aus der Liste ab — einzeln über die Auswahl oder die
          ganze Trefferliste eines Filters — um sie hier gemeinsam zu bearbeiten
          oder nacheinander durchzugehen.
        </p>
      </div>

      <ul v-else class="basket-list">
        <li v-for="doc in items" :key="doc.id" class="basket-row">
          <button
            type="button"
            class="basket-row-body"
            :aria-label="`Dokument öffnen: ${doc.title ?? doc.original_filename}`"
            @click="openDocument(doc)"
          >
            <div class="basket-row-title">
              {{ doc.title ?? doc.original_filename }}
              <span
                v-if="doc.status === 'ready' && !doc.attributes_reviewed"
                class="new-badge"
                title="KI-Zuordnung noch nicht bestätigt"
              >Neu</span>
            </div>
            <div class="basket-row-meta">
              <span v-if="doc.sender">{{ doc.sender }}</span>
              <span v-if="doc.doc_date">{{ formatDate(doc.doc_date) }}</span>
              <span v-if="doc.category_slug"><i class="pi pi-folder" /> {{ doc.category_slug }}</span>
              <span v-if="doc.tax_relevant" class="tax-badge"><i class="pi pi-calculator" /> Steuer</span>
            </div>
          </button>
          <button
            type="button"
            class="basket-row-remove"
            :aria-label="`Aus Basket entfernen: ${doc.title ?? doc.original_filename}`"
            @click="selectionStore.remove(doc.id)"
          >
            <i class="pi pi-times-circle" />
          </button>
        </li>
      </ul>

      <template #footer>
        <div class="drawer-footer">
          <Message v-if="actionInfo" severity="success" :closable="true" class="action-message" @close="actionInfo = null">{{ actionInfo }}</Message>
          <Message v-if="actionError" severity="error" :closable="true" class="action-message" @close="actionError = null">{{ actionError }}</Message>
          <div v-if="canEdit" class="action-row">
            <Button label="Tags" icon="pi pi-tag" size="small" :disabled="count === 0" @click="openTagDialog" />
            <Button label="Kategorie" icon="pi pi-folder" size="small" :disabled="count === 0" @click="openCategoryDialog" />
            <Button label="Datum" icon="pi pi-calendar" size="small" :disabled="count === 0" @click="openDateDialog" />
          </div>
          <div v-if="canEdit" class="action-row">
            <Button label="Steuer" icon="pi pi-calculator" size="small" severity="secondary" outlined :disabled="count === 0" @click="openTaxDialog" />
            <Button label="Personen" icon="pi pi-id-card" size="small" severity="secondary" outlined :disabled="count === 0" @click="openPersonsDialog" />
          </div>
          <div v-if="canEdit" class="action-row">
            <Button
              :label="newCount > 0 ? `Zuordnung bestätigen (${newCount} neu)` : 'Zuordnung bestätigen'"
              icon="pi pi-check-circle"
              size="small"
              severity="success"
              outlined
              :disabled="count === 0"
              :loading="approving"
              v-tooltip.bottom="'KI-Zuordnung aller Dokumente im Basket bestätigen — fixiert die Attribute und entfernt das Neu-Kennzeichen.'"
              @click="approveAttribution"
            />
          </div>
          <div class="clear-row">
            <Button
              label="Alles leeren"
              icon="pi pi-times"
              severity="secondary"
              text
              size="small"
              :disabled="count === 0"
              @click="selectionStore.clear()"
            />
          </div>
        </div>
      </template>
    </Drawer>

    <MultiSelectDialog
      v-model:visible="tagDialogVisible"
      title="Tags auf Basket anwenden"
      :items="tagDialogItems"
      :initial-states="tagInitialStates"
      :subject-count="count"
      :subject-label="count === 1 ? 'Dokument' : 'Dokumente'"
      :saving="savingTags"
      allow-create
      create-label="Neuen Tag eintragen"
      create-placeholder="Tagname…"
      empty-message="Keine bekannten Tags. Lege einen neuen an."
      @save="handleTagSave"
      @create="handleTagCreate"
    />

    <Dialog v-model:visible="categoryDialogVisible" modal header="Kategorie setzen" class="basket-dialog">
      <p class="dialog-hint">
        Setzt die Kategorie auf {{ count }} Dokument{{ count === 1 ? '' : 'e' }} und
        fixiert sie gegen die automatische Neuklassifizierung.
      </p>
      <TreeSelect
        v-model="categorySelection"
        :options="categoryTree"
        selection-mode="single"
        placeholder="Kategorie wählen"
        filter
        filter-placeholder="Kategorie suchen…"
        class="dialog-field"
      />
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="categoryDialogVisible = false" />
        <Button
          label="Übernehmen"
          :loading="savingCategory"
          :disabled="categoryDraft === null"
          @click="saveCategory"
        />
      </template>
    </Dialog>

    <Dialog v-model:visible="dateDialogVisible" modal header="Dokumentdatum setzen" class="basket-dialog">
      <p class="dialog-hint">
        Setzt das Dokumentdatum auf {{ count }} Dokument{{ count === 1 ? '' : 'e' }}.
        Ohne Auswahl wird das Datum entfernt.
      </p>
      <DatePicker
        v-model="dateDraft"
        date-format="dd.mm.yy"
        show-icon
        show-button-bar
        placeholder="Datum wählen"
        class="dialog-field"
      />
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="dateDialogVisible = false" />
        <Button label="Übernehmen" :loading="savingDate" @click="saveDate" />
      </template>
    </Dialog>

    <Dialog v-model:visible="taxDialogVisible" modal header="Steuer-Metadaten setzen" class="basket-dialog">
      <p class="dialog-hint">
        Überschreibt Steuer-Relevanz, Jahr und Steuer-Kategorien auf
        {{ count }} Dokument{{ count === 1 ? '' : 'e' }} (ersetzt vorhandene Zuordnungen).
      </p>
      <label class="tax-relevant-row">
        <Checkbox v-model="taxRelevantDraft" binary />
        <span>Steuerrelevant</span>
      </label>
      <template v-if="taxRelevantDraft">
        <InputNumber
          v-model="taxYearDraft"
          :use-grouping="false"
          :min="2000"
          :max="2100"
          placeholder="Steuerjahr"
          class="dialog-field"
        />
        <MultiSelect
          v-model="taxSectionsDraft"
          :options="taxSectionOptions"
          option-label="label"
          option-value="value"
          placeholder="Steuer-Kategorien wählen"
          display="chip"
          filter
          class="dialog-field"
        />
      </template>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="taxDialogVisible = false" />
        <Button label="Übernehmen" :loading="savingTax" :disabled="taxSaveDisabled" @click="saveTax" />
      </template>
    </Dialog>

    <Dialog v-model:visible="personsDialogVisible" modal header="Bezugspersonen" class="basket-dialog">
      <p class="dialog-hint">
        Verknüpft Bezugspersonen mit {{ count }} Dokument{{ count === 1 ? '' : 'en' }}
        oder entfernt sie davon.
      </p>
      <SelectButton
        v-model="personsMode"
        :options="personsModeOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        class="dialog-field"
      />
      <MultiSelect
        v-model="personsDraft"
        :options="personOptions"
        option-label="label"
        option-value="value"
        placeholder="Bezugspersonen wählen"
        display="chip"
        filter
        class="dialog-field"
      />
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="personsDialogVisible = false" />
        <Button
          :label="personsMode === 'add' ? 'Hinzufügen' : 'Entfernen'"
          :loading="savingPersons"
          :disabled="personsDraft.length === 0"
          @click="savePersons"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.basket-indicator {
  position: relative;
  display: inline-flex;
}

.drawer-header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}
.drawer-title {
  font-weight: 600;
  font-size: 1.05rem;
}
.drawer-count {
  color: var(--p-text-muted-color);
  font-size: 0.95rem;
}

.basket-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 2rem 1rem;
  color: var(--p-text-muted-color);
}
.basket-empty-icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}
.basket-empty .hint {
  font-size: 0.85rem;
  margin-top: 0.25rem;
}

.basket-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}
.basket-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.basket-row:last-child {
  border-bottom: none;
}
.basket-row-body {
  appearance: none;
  background: none;
  border: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  padding: 0.25rem;
  border-radius: 0.35rem;
}
.basket-row-body:hover,
.basket-row-body:focus-visible {
  background: var(--p-content-hover-background);
}
.basket-row-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.basket-row-meta {
  margin-top: 0.1rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  color: var(--p-text-muted-color);
  font-size: 0.82rem;
}
.basket-row-meta span {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.tax-badge {
  color: var(--p-primary-color);
}
.new-badge {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.05rem 0.4rem;
  border-radius: 0.6rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--p-primary-color);
  background: var(--p-highlight-background);
  vertical-align: text-bottom;
}
.basket-row-remove {
  background: none;
  border: none;
  padding: 0.25rem;
  cursor: pointer;
  color: var(--p-text-muted-color);
  border-radius: 0.25rem;
  flex-shrink: 0;
}
.basket-row-remove:hover {
  color: var(--p-text-color);
  background: var(--p-content-hover-background);
}

.drawer-footer {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.action-message {
  margin: 0;
}
.action-row {
  display: flex;
  gap: 0.5rem;
}
.action-row :deep(.p-button) {
  flex: 1;
  min-width: 0;
}
/* Buttons share the row equally; clip an over-long label ("Kategorie") with
   an ellipsis instead of forcing the row wider or wrapping the text. */
.action-row :deep(.p-button-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clear-row {
  display: flex;
  justify-content: flex-end;
}

.basket-dialog .dialog-hint,
.dialog-hint {
  margin: 0 0 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}
.dialog-field {
  width: 100%;
  margin-bottom: 0.75rem;
}
.tax-relevant-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  cursor: pointer;
}
</style>
