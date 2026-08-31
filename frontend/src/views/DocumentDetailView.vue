<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'
import InputText from 'primevue/inputtext'
import Dialog from 'primevue/dialog'
import { toLocalIsoDate, parseLocalDate } from '../utils/dateFormat'
import { buildCategoryOptions, filterOptions, type SlugOption } from '../utils/categoryOptions'
import Message from 'primevue/message'
import Select from 'primevue/select'
import AutoComplete from 'primevue/autocomplete'
import MultiSelect from 'primevue/multiselect'
import Tag from 'primevue/tag'
import Chip from 'primevue/chip'
import Popover from 'primevue/popover'
import { useConfirm } from 'primevue/useconfirm'
import {
  deleteDocument,
  dismissDocumentError,
  downloadDocument,
  fetchDocumentBytes,
  getDocument,
  getDocumentText,
  listDocumentCategories,
  listDocumentTypesCatalog,
  listTaxSectionsCatalog,
  proposeCategory,
  reclassifyDocument,
  replaceDocumentFile,
  setTeacherRequested,
  unlockDocument,
  updateDocument,
  updateDocumentTax,
  updateDocumentVisibility,
  listGroups,
  listSubjectPersons,
  type DocumentCategory,
  type DocumentDetail,
  type DocumentStatus,
  type DocumentTypeCatalogEntry,
  type DocumentVisibility,
  type GroupSummary,
  type SubjectPerson,
  type TaxSectionCatalogEntry,
  type TaxSectionGroup,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'
import { useDocSelectionStore } from '../stores/documents/selection'
import { useRealtimeEvent } from '../composables/useRealtime'
import { useModuleBack } from '../composables/useModuleBack'
import PdfViewer from '../components/PdfViewer.vue'
import DocumentFollowUpDialog from '../components/DocumentFollowUpDialog.vue'
import { getDocumentTransactionLinks, unlinkTransactionDocument } from '../api/finance'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const confirmDialog = useConfirm()

const docId = computed(() => parseInt(route.params.id as string, 10))

// ─── Basket navigation (issue #736) ─────────────────────────────────────────
// When the open document is in the basket, the basket doubles as a result
// list: prev/next step through it in order.
const basket = useDocSelectionStore()
const basketIndex = computed(() => basket.indexOf(docId.value))
const basketPrev = computed(() =>
  basketIndex.value > 0 ? basket.items[basketIndex.value - 1] : null,
)
const basketNext = computed(() =>
  basketIndex.value >= 0 && basketIndex.value < basket.count - 1
    ? basket.items[basketIndex.value + 1]
    : null,
)

function goBasketDoc(id: number) {
  router.push({ name: 'dokumente-detail', params: { id } })
}

const inBasket = computed(() => basketIndex.value >= 0)

function toggleBasket() {
  if (!doc.value) return
  basket.toggle(doc.value)
}

const doc = ref<DocumentDetail | null>(null)
const categories = ref<DocumentCategory[]>([])
const documentTypes = ref<DocumentTypeCatalogEntry[]>([])
const groups = ref<GroupSummary[]>([])
const taxCatalog = ref<TaxSectionCatalogEntry[]>([])
const subjectPeople = ref<SubjectPerson[]>([])
const loading = ref(true)
const linkedTransactions = ref<Array<{ transaction_id: number; booking_date: string; amount: string; counterparty: string | null }>>([])
const openedFromTransactionId = computed(() => {
  const value = Number(route.query.fromTransaction)
  return Number.isSafeInteger(value) && value > 0 ? value : null
})
async function unlinkTransaction(transactionId: number) {
  try {
    await unlinkTransactionDocument(transactionId, docId.value)
    linkedTransactions.value = linkedTransactions.value.filter(t => t.transaction_id !== transactionId)
  } catch (err: any) {
    error.value = err.message || 'Verknüpfung konnte nicht getrennt werden'
  }
}
function requestUnlinkTransaction(transactionId: number) {
  confirmDialog.require({
    message: 'Verknüpfung zu dieser Buchung wirklich trennen?',
    header: 'Buchungsverknüpfung trennen',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Trennen', severity: 'danger' },
    accept: () => { void unlinkTransaction(transactionId) },
  })
}
const saving = ref(false)
const savingTax = ref(false)
const editingTax = ref(false)
const error = ref('')
const info = ref('')
const pdfData = ref<Uint8Array | null>(null)
const pdfError = ref('')
const helpPopover = ref<InstanceType<typeof Popover> | null>(null)

function toggleHelp(event: Event) {
  helpPopover.value?.toggle(event)
}

const form = ref({
  title: '' as string,
  doc_date: null as Date | null,
  sender: '' as string,
  document_number: '' as string,
  summary: '' as string,
  notes: '' as string,
  category_slug: null as string | null,
  document_type: null as string | null,
  tagsText: '' as string,
  subject_person_ids: [] as number[],
  visibility: 'private' as DocumentVisibility,
  group_id: null as number | null,
})

const taxForm = ref({
  tax_relevant: false,
  tax_year: null as number | null,
  sections: new Set<string>(),
})

const followUpOpen = ref(false)

function onFollowUpDone() {
  followUpOpen.value = false
  info.value = 'Dokument auf Wiedervorlage gelegt.'
}

// ─── Volltext-Anzeige ────────────────────────────────────────────────────────
// The detail payload only carries a truncated preview; the full OCR text is
// fetched lazily the first time the user expands it.
const fullText = ref<string | null>(null)
const fullTextVisible = ref(false)
const fullTextLoading = ref(false)

async function toggleFullText() {
  if (fullTextVisible.value) {
    fullTextVisible.value = false
    return
  }
  if (fullText.value === null && doc.value) {
    fullTextLoading.value = true
    try {
      const res = await getDocumentText(doc.value.id)
      fullText.value = res.text ?? ''
    } catch (err: any) {
      error.value = err.message || 'Volltext konnte nicht geladen werden'
      return
    } finally {
      fullTextLoading.value = false
    }
  }
  fullTextVisible.value = true
}

// "Keine passende Kategorie — neue vorschlagen"
const proposeOpen = ref(false)
const proposeName = ref('')
const proposeParentSlug = ref<string | null>(null)
const proposeMoveToSonstiges = ref(true)
const proposing = ref(false)

// Parent options: only top-level categories (a new category hangs under one).
const parentCategoryOptions = computed(() => {
  const opts: Array<{ label: string; value: string | null }> = [{ label: '— keine (Oberkategorie) —', value: null }]
  for (const c of categories.value) {
    if (c.parent_id == null) opts.push({ label: c.name, value: c.slug })
  }
  return opts
})

function openPropose() {
  if (!doc.value) return
  proposeName.value = (doc.value.sender ?? doc.value.title ?? '').trim()
  proposeParentSlug.value = null
  proposeMoveToSonstiges.value = doc.value.category_slug !== 'sonstiges'
  proposeOpen.value = true
}

async function onProposeCategory() {
  if (!doc.value) return
  if (!proposeName.value.trim()) {
    error.value = 'Bitte einen Namen für die vorgeschlagene Kategorie angeben.'
    return
  }
  proposing.value = true
  error.value = ''
  info.value = ''
  try {
    doc.value = await proposeCategory(doc.value.id, {
      suggested_name: proposeName.value.trim(),
      parent_slug: proposeParentSlug.value,
      move_to_sonstiges: proposeMoveToSonstiges.value,
    })
    resetForm()
    proposeOpen.value = false
    info.value = proposeMoveToSonstiges.value
      ? 'Kategorie-Vorschlag eingereicht — Dokument vorerst auf „Sonstiges" gesetzt. Ein Admin entscheidet darüber.'
      : 'Kategorie-Vorschlag eingereicht. Ein Admin entscheidet darüber.'
  } catch (err: any) {
    error.value = err.message || 'Vorschlag konnte nicht eingereicht werden'
  } finally {
    proposing.value = false
  }
}

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

// Every taxonomy level, alphabetically sorted, parents immediately followed
// by their descendants — so the list reads A→Z instead of following the
// backend's sort_order, deeper levels (e.g. Wohnen › Haus & Grund ›
// Grundsteuer) are selectable at all, and typing a parent name reveals its
// subcategories. See utils/categoryOptions.ts.
const categoryOptions = computed<SlugOption[]>(() => buildCategoryOptions(categories.value))

const documentTypeOptions = computed<SlugOption[]>(() =>
  documentTypes.value
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map((t) => ({ label: t.name, slug: t.slug, search: t.name.toLowerCase() })),
)

// ─── Typeahead selects (Kategorie / Dokumentart) ────────────────────────────
const selectedCategoryOption = ref<SlugOption | null>(null)
const categorySuggestions = ref<SlugOption[]>([])

function syncCategorySelection() {
  selectedCategoryOption.value = form.value.category_slug
    ? categoryOptions.value.find((o) => o.slug === form.value.category_slug) ?? null
    : null
}

function searchCategories(event: { query: string }) {
  categorySuggestions.value = filterOptions(categoryOptions.value, event.query)
}

watch(selectedCategoryOption, (v) => {
  form.value.category_slug = v ? v.slug : null
})

const selectedDocumentTypeOption = ref<SlugOption | null>(null)
const documentTypeSuggestions = ref<SlugOption[]>([])

function syncDocumentTypeSelection() {
  selectedDocumentTypeOption.value = form.value.document_type
    ? documentTypeOptions.value.find((o) => o.slug === form.value.document_type) ?? null
    : null
}

function searchDocumentTypes(event: { query: string }) {
  documentTypeSuggestions.value = filterOptions(documentTypeOptions.value, event.query)
}

watch(selectedDocumentTypeOption, (v) => {
  form.value.document_type = v ? v.slug : null
})

async function load() {
  const id = docId.value
  if (!Number.isFinite(id)) return

  loading.value = true
  error.value = ''
  try {
    const [detail, cats, docTypes, taxCats, houseItems, people, links] = await Promise.all([
      getDocument(id),
      listDocumentCategories(),
      listDocumentTypesCatalog(),
      listTaxSectionsCatalog(),
      listGroups(),
      listSubjectPersons(),
      getDocumentTransactionLinks(id).catch(() => []),
    ])
    doc.value = detail
    categories.value = cats.items
    documentTypes.value = docTypes.items
    taxCatalog.value = taxCats.items
    groups.value = houseItems.items
    subjectPeople.value = people.items
    linkedTransactions.value = links
    // Cached full text belongs to the previously shown document/state.
    fullText.value = null
    fullTextVisible.value = false
    resetForm()
    resetTaxForm()
    await loadPdf(id)
  } catch (err: any) {
    error.value = err.message || 'Dokument konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

async function loadPdf(id?: number) {
  const resolvedId = id ?? docId.value
  if (!Number.isFinite(resolvedId)) return

  pdfData.value = null
  pdfError.value = ''
  try {
    pdfData.value = await fetchDocumentBytes(resolvedId)
  } catch (err: any) {
    pdfError.value = err.message || 'PDF kann nicht geladen werden'
  }
}

function resetForm() {
  if (!doc.value) return
  form.value = {
    title: doc.value.title ?? '',
    doc_date: doc.value.doc_date ? parseLocalDate(doc.value.doc_date) : null,
    sender: doc.value.sender ?? '',
    document_number: doc.value.document_number ?? '',
    summary: doc.value.summary ?? '',
    notes: doc.value.notes ?? '',
    category_slug: doc.value.category_slug,
    document_type: doc.value.document_type,
    tagsText: doc.value.tags.join(', '),
    subject_person_ids: doc.value.subject_persons.map((p) => p.id),
    visibility: doc.value.visibility,
    group_id: doc.value.group_id,
  }
  syncCategorySelection()
  syncDocumentTypeSelection()
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
        doc_date: form.value.doc_date ? toLocalIsoDate(form.value.doc_date) : null,
        sender: form.value.sender.trim() || null,
        document_number: form.value.document_number.trim() || null,
        summary: form.value.summary.trim() || null,
        notes: form.value.notes.trim() || null,
        category_slug: form.value.category_slug,
        document_type: form.value.document_type,
        tags,
        subject_person_ids: form.value.subject_person_ids,
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

async function onUnpinAttributes() {
  if (!doc.value) return
  saving.value = true
  error.value = ''
  info.value = ''
  try {
    // Clear the pin, then re-run the classifier so it re-derives the fields.
    doc.value = await updateDocument(doc.value.id, { attributes_reviewed: false })
    await reclassifyDocument(doc.value.id, {})
    resetForm()
    info.value = 'Felder wieder freigegeben — KI-Neuanalyse läuft.'
    setTimeout(load, 1500)
  } catch (err: any) {
    error.value = err.message || 'Aktion fehlgeschlagen'
  } finally {
    saving.value = false
  }
}

async function onUnpinTax() {
  if (!doc.value) return
  savingTax.value = true
  error.value = ''
  info.value = ''
  try {
    // Release the pin so the classifier may overwrite tax fields on the next run.
    doc.value = await updateDocumentTax(doc.value.id, {
      tax_relevant: doc.value.tax_relevant,
      tax_year: doc.value.tax_year,
      tax_sections: doc.value.tax_sections.map((s) => s.slug),
      tax_reviewed: false,
    })
    await reclassifyDocument(doc.value.id, {})
    info.value = 'Steuer-Pin aufgehoben — KI-Neuanalyse läuft.'
    setTimeout(load, 1500)
  } catch (err: any) {
    error.value = err.message || 'Aktion fehlgeschlagen'
  } finally {
    savingTax.value = false
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

async function onToggleTeacherRequested() {
  if (!doc.value) return
  saving.value = true
  error.value = ''
  info.value = ''
  try {
    const next = !doc.value.teacher_requested
    doc.value = await setTeacherRequested(doc.value.id, next)
    info.value = next
      ? 'Für den nächsten Cloud-Lehrer-Lauf vorgemerkt.'
      : 'Vormerkung für den Cloud-Lehrer aufgehoben.'
  } catch (err: any) {
    error.value = err.message || 'Aktion fehlgeschlagen'
  } finally {
    saving.value = false
  }
}

const downloading = ref(false)
const unlockPassword = ref('')
const unlocking = ref(false)

async function onUnlock() {
  if (!doc.value) return
  if (unlockPassword.value.length === 0) {
    error.value = 'Bitte ein Passwort eingeben.'
    return
  }
  unlocking.value = true
  error.value = ''
  info.value = ''
  try {
    doc.value = await unlockDocument(doc.value.id, unlockPassword.value)
    unlockPassword.value = ''
    info.value = 'Dokument entschlüsselt und unverschlüsselt gespeichert — Verarbeitung läuft.'
    await loadPdf(doc.value.id)
    setTimeout(load, 1500)
  } catch (err: any) {
    error.value = err.message || 'Entsperren fehlgeschlagen'
  } finally {
    unlocking.value = false
  }
}

async function onDownload() {
  if (!doc.value) return
  downloading.value = true
  error.value = ''
  try {
    const name = doc.value.original_filename || `${doc.value.title || 'dokument'}.pdf`
    await downloadDocument(doc.value.id, name)
  } catch (err: any) {
    error.value = err.message || 'Download fehlgeschlagen'
  } finally {
    downloading.value = false
  }
}

function onDelete() {
  if (!doc.value) return
  confirmDialog.require({
    message: 'Dokument wirklich endgültig löschen? Diese Aktion kann nicht rückgängig gemacht werden.',
    header: 'Dokument löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Löschen', severity: 'danger' },
    accept: async () => {
      try {
        await deleteDocument(doc.value!.id)
        void router.push({ name: 'dokumente-list' })
      } catch (err: any) {
        error.value = err.message || 'Löschen fehlgeschlagen'
      }
    },
  })
}

const dismissingError = ref(false)

async function onDismissError() {
  if (!doc.value) return
  dismissingError.value = true
  error.value = ''
  info.value = ''
  try {
    doc.value = await dismissDocumentError(doc.value.id)
    info.value = 'Fehler verworfen — das Dokument gilt als manuell erfasst.'
  } catch (err: any) {
    error.value = err.message || 'Fehler konnte nicht verworfen werden'
  } finally {
    dismissingError.value = false
  }
}

const replaceFileInput = ref<HTMLInputElement | null>(null)
const replacing = ref(false)

function onReplaceFileClick() {
  replaceFileInput.value?.click()
}

async function onReplaceFileSelected(event: Event) {
  if (!doc.value) return
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  replacing.value = true
  error.value = ''
  info.value = ''
  try {
    await replaceDocumentFile(doc.value.id, file)
    info.value = 'Datei ersetzt — Verarbeitung läuft.'
    setTimeout(load, 1500)
  } catch (err: any) {
    error.value = err.message || 'Datei konnte nicht ersetzt werden'
  } finally {
    replacing.value = false
    if (replaceFileInput.value) replaceFileInput.value.value = ''
  }
}

/**
 * "Zurück" should return to wherever the user came from *within Dokumente* —
 * Steuer-View, normal list, search result, etc. `useModuleBack` only calls
 * `router.back()` when the previous entry is under `/dokumente`; otherwise
 * (deep link, reload, or arriving from another module like Finanzen) it falls
 * back to the document list so back never leaves the module. (#651)
 */
const { goBack: goModuleBack } = useModuleBack('/dokumente', 'dokumente-list')
function goBack() {
  if (openedFromTransactionId.value !== null) {
    void router.push({ name: 'finance-transaction-detail', params: { id: openedFromTransactionId.value } })
    return
  }
  goModuleBack()
}

function statusSeverity(status: DocumentStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (status) {
    case 'ready': return 'success'
    case 'failed': return 'danger'
    case 'encrypted': return 'warn'
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
    case 'encrypted': return 'Passwortgeschützt'
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
      <Button icon="pi pi-arrow-left" label="Zurück" aria-label="Zurück" text @click="goBack" />
      <div v-if="basketIndex >= 0" class="basket-nav" aria-label="Navigation durch den Basket">
        <Button
          icon="pi pi-chevron-left"
          text
          rounded
          :disabled="!basketPrev"
          aria-label="Vorheriges Dokument im Basket"
          v-tooltip.bottom="'Vorheriges Dokument im Basket'"
          @click="basketPrev && goBasketDoc(basketPrev.id)"
        />
        <span class="basket-nav-pos">
          <i class="pi pi-shopping-cart" /> {{ basketIndex + 1 }}&hairsp;/&hairsp;{{ basket.count }}
        </span>
        <Button
          icon="pi pi-chevron-right"
          text
          rounded
          :disabled="!basketNext"
          aria-label="Nächstes Dokument im Basket"
          v-tooltip.bottom="'Nächstes Dokument im Basket'"
          @click="basketNext && goBasketDoc(basketNext.id)"
        />
      </div>
      <div class="header-actions">
        <Button
          v-if="doc"
          :icon="inBasket ? 'pi pi-cart-minus' : 'pi pi-shopping-cart'"
          :label="inBasket ? 'Im Basket' : 'In den Basket'"
          :aria-label="inBasket ? 'Aus dem Basket entfernen' : 'In den Basket legen'"
          text
          :severity="inBasket ? 'success' : undefined"
          v-tooltip.bottom="inBasket ? 'Aus dem Basket entfernen' : 'Dokument in den Basket legen'"
          @click="toggleBasket"
        />
        <Button
          v-if="auth.hasPermission('documents.edit') && doc"
          icon="pi pi-refresh"
          label="Neu klassifizieren"
          aria-label="Neu klassifizieren"
          text
          :loading="saving"
          @click="onReclassify()"
        />
        <Button
          v-if="auth.hasPermission('documents.edit') && doc"
          icon="pi pi-eye"
          label="OCR erzwingen"
          aria-label="OCR erzwingen"
          text
          :loading="saving"
          title="Text-Layer der PDF ignorieren und komplett per OCR neu einlesen (hilft bei Scans mit fehlenden Leerzeichen)."
          @click="onReclassify({ forceOcr: true })"
        />
        <Button
          v-if="auth.hasPermission('documents.edit') && doc"
          :icon="doc.teacher_requested ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'"
          :label="doc.teacher_requested ? 'Vorgemerkt' : 'Für Cloud-Lehrer vormerken'"
          :aria-label="doc.teacher_requested ? 'Vormerkung aufheben' : 'Für Cloud-Lehrer vormerken'"
          text
          :loading="saving"
          :title="doc.teacher_requested
            ? 'Dieses Dokument ist für den nächsten Cloud-Lehrer-Lauf vorgemerkt. Klicken zum Aufheben.'
            : 'Schwer einzuordnen? Für den nächsten Cloud-Lehrer-Lauf vormerken — die Cloud klassifiziert es dann vorrangig.'"
          @click="onToggleTeacherRequested"
        />
        <Button
          v-if="doc"
          icon="pi pi-download"
          label="Herunterladen"
          aria-label="Herunterladen"
          text
          :loading="downloading"
          title="Dokument herunterladen — mit durchsuchbarer Textebene (wird bei reinen Scans bei Bedarf erzeugt)."
          @click="onDownload"
        />
        <Button
          v-if="doc"
          icon="pi pi-clock"
          label="Wiedervorlage"
          aria-label="Wiedervorlage"
          text
          title="Dokument auf Wiedervorlage legen — es taucht am gewählten Datum wieder im Arbeitskorb auf."
          @click="followUpOpen = true"
        />
        <Button
          v-if="auth.hasPermission('documents.delete') && doc"
          icon="pi pi-trash"
          severity="danger"
          text
          label="Löschen"
          aria-label="Löschen"
          @click="onDelete"
        />
        <Button
          icon="pi pi-question-circle"
          aria-label="Hilfe zu den Aktionen"
          text
          class="help-trigger"
          @click="toggleHelp"
        />
        <Popover ref="helpPopover">
          <div class="help-flyout">
            <h3 class="help-flyout__title">Aktionen</h3>
            <ul class="help-flyout__list">
              <li>
                <i class="pi pi-arrow-left" aria-hidden="true" />
                <div>
                  <strong>Zurück</strong>
                  <span>Zur Dokumentenliste zurückkehren.</span>
                </div>
              </li>
              <li>
                <i class="pi pi-shopping-cart" aria-hidden="true" />
                <div>
                  <strong>In den Basket</strong>
                  <span>Dokument in den Basket legen bzw. wieder entfernen — für Stapelbearbeitung oder als Navigationsliste.</span>
                </div>
              </li>
              <li v-if="auth.hasPermission('documents.edit')">
                <i class="pi pi-refresh" aria-hidden="true" />
                <div>
                  <strong>Neu klassifizieren</strong>
                  <span>KI analysiert Kategorie, Datum, Absender und Zusammenfassung erneut.</span>
                </div>
              </li>
              <li v-if="auth.hasPermission('documents.edit')">
                <i class="pi pi-eye" aria-hidden="true" />
                <div>
                  <strong>OCR erzwingen</strong>
                  <span>Text-Layer der PDF ignorieren und komplett per OCR neu einlesen — hilft bei Scans mit fehlenden Leerzeichen.</span>
                </div>
              </li>
              <li>
                <i class="pi pi-download" aria-hidden="true" />
                <div>
                  <strong>Herunterladen</strong>
                  <span>Dokument als Datei speichern — mit durchsuchbarer Textebene. Bei reinen Scans wird die Textebene bei Bedarf per OCR erzeugt.</span>
                </div>
              </li>
              <li v-if="auth.hasPermission('documents.delete')">
                <i class="pi pi-trash" aria-hidden="true" />
                <div>
                  <strong>Löschen</strong>
                  <span>Dokument dauerhaft entfernen.</span>
                </div>
              </li>
            </ul>
          </div>
        </Popover>
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
          <div class="replace-file-error">
            <span><strong>Verarbeitung fehlgeschlagen:</strong> {{ doc.last_error }}</span>
            <Button
              v-if="auth.hasPermission('documents.edit')"
              label="Datei ersetzen"
              icon="pi pi-upload"
              size="small"
              severity="secondary"
              :loading="replacing"
              @click="onReplaceFileClick"
            />
            <!-- The file is often fine and only the automatic classification
                 wasn't; then the fix is to fill the metadata in by hand and
                 mark the document done, not to upload it again. -->
            <Button
              v-if="auth.hasPermission('documents.edit')"
              label="Fehler verwerfen"
              icon="pi pi-check"
              size="small"
              severity="secondary"
              :loading="dismissingError"
              @click="onDismissError"
            />
          </div>
        </Message>

        <Message
          v-if="doc.status === 'encrypted'"
          severity="warn"
          :closable="false"
          icon="pi pi-lock"
        >
          <div class="unlock-box">
            <span>
              <strong>Passwortgeschützt:</strong> Dieses PDF benötigt ein Passwort.
              Nach Eingabe wird es entschlüsselt und unverschlüsselt gespeichert –
              danach ist kein Passwort mehr nötig.
            </span>
            <form
              v-if="auth.hasPermission('documents.edit')"
              class="unlock-row"
              @submit.prevent="onUnlock"
            >
              <InputText
                v-model="unlockPassword"
                type="password"
                placeholder="PDF-Passwort"
                autocomplete="off"
                :disabled="unlocking"
              />
              <Button
                type="submit"
                label="Entsperren & speichern"
                icon="pi pi-unlock"
                size="small"
                :loading="unlocking"
                :disabled="unlockPassword.length === 0"
              />
            </form>
            <span v-else class="hint">
              Zum Entsperren wird die Berechtigung „documents.edit" benötigt.
            </span>
          </div>
        </Message>
        <input
          ref="replaceFileInput"
          type="file"
          accept=".pdf,application/pdf"
          style="display:none"
          @change="onReplaceFileSelected"
        />

        <div class="meta-summary" v-if="doc.summary">
          <i class="pi pi-info-circle" />
          <span>{{ doc.summary }}</span>
        </div>

        <div v-if="linkedTransactions.length && openedFromTransactionId === null" class="linked-tx-section">
          <span class="label">Verknüpfte Buchungen</span>
          <div class="linked-tx-list">
            <div v-for="tx in linkedTransactions" :key="tx.transaction_id" class="linked-tx-row">
              <Button
                :label="`${tx.counterparty ?? 'Buchung'} · ${tx.amount}`"
                size="small"
                text
                icon="pi pi-external-link"
                class="linked-tx-btn"
                @click="router.push({ name: 'finance-transaction-detail', params: { id: tx.transaction_id } })"
              />
              <Button
                icon="pi pi-times"
                size="small"
                text
                severity="secondary"
                aria-label="Buchungsverknüpfung trennen"
                @click="requestUnlinkTransaction(tx.transaction_id)"
              />
            </div>
          </div>
        </div>

        <div class="meta-form">
          <label>
            <span class="label">Titel</span>
            <InputText v-model="form.title" :disabled="!auth.hasPermission('documents.edit')" />
          </label>
          <div class="meta-form-row">
            <label>
              <span class="label">Datum</span>
              <DatePicker
                v-model="form.doc_date"
                dateFormat="dd.mm.yy"
                showIcon
                fluid
                showButtonBar
                :disabled="!auth.hasPermission('documents.edit')"
              />
            </label>
            <label>
              <span class="label">Absender</span>
              <InputText v-model="form.sender" :disabled="!auth.hasPermission('documents.edit')" />
            </label>
            <label>
              <span class="label">Dok.-Nr.</span>
              <InputText v-model="form.document_number" :disabled="!auth.hasPermission('documents.edit')" placeholder="#1234" />
            </label>
          </div>
          <div class="meta-form-field">
            <span class="label">Kategorie</span>
            <AutoComplete
              v-model="selectedCategoryOption"
              :suggestions="categorySuggestions"
              optionLabel="label"
              dropdown
              showClear
              placeholder="Keine"
              :inputStyle="{ width: '100%' }"
              :disabled="!auth.hasPermission('documents.edit')"
              @complete="searchCategories"
            />
            <Button
              v-if="auth.hasPermission('documents.edit')"
              class="propose-link"
              label="Keine passende Kategorie? Neue vorschlagen"
              icon="pi pi-lightbulb"
              text
              size="small"
              @click="openPropose"
            />
          </div>
          <div class="meta-form-field">
            <span class="label">Dokumentart</span>
            <AutoComplete
              v-model="selectedDocumentTypeOption"
              :suggestions="documentTypeSuggestions"
              optionLabel="label"
              dropdown
              showClear
              placeholder="Keine"
              :inputStyle="{ width: '100%' }"
              :disabled="!auth.hasPermission('documents.edit')"
              @complete="searchDocumentTypes"
            />
          </div>
          <div
            v-if="doc?.retention && doc.retention.cls !== 'unbekannt'"
            class="retention-hint"
          >
            <i class="pi pi-clock" />
            <span>
              <strong>Aufbewahrung:</strong> {{ doc.retention.label }}
              <template v-if="doc.retention.retain_until_year != null">
                — voraussichtlich entbehrlich ab {{ doc.retention.retain_until_year }}
              </template>
              <span class="retention-note">{{ doc.retention.note }} (Orientierung, keine Rechtsberatung)</span>
            </span>
          </div>
          <label>
            <span class="label">Tags (Komma-getrennt)</span>
            <InputText v-model="form.tagsText" :disabled="!auth.hasPermission('documents.edit')" />
          </label>
          <label>
            <span class="label">Bezugspersonen</span>
            <MultiSelect
              v-model="form.subject_person_ids"
              :options="subjectPeople"
              optionLabel="full_name"
              optionValue="id"
              display="chip"
              filter
              :showToggleAll="false"
              :disabled="!auth.hasPermission('documents.edit')"
              placeholder="Keine"
              :emptyMessage="'Noch keine Bezugspersonen angelegt'"
            />
            <small v-if="doc.subject_persons.some((p) => p.source === 'ai')" class="hint">
              Automatisch erkannte sind mit
              <i class="pi pi-sparkles" /> markiert; deine Auswahl bleibt bei einer
              Neuanalyse erhalten.
            </small>
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

          <label>
            <span class="label">Notizen</span>
            <textarea
              v-model="form.notes"
              class="p-inputtextarea p-inputtext"
              rows="3"
              placeholder="Eigene Notizen zu diesem Dokument…"
              :disabled="!auth.hasPermission('documents.edit')"
            />
          </label>

          <div v-if="doc.tags.length > 0" class="current-tags">
            <Chip v-for="t in doc.tags" :key="t" :label="t" />
          </div>

          <Message
            v-if="doc.attributes_reviewed"
            severity="info"
            :closable="false"
            icon="pi pi-lock"
            class="pinned-notice"
          >
            <div class="pinned-notice-body">
              <span>
                Diese Felder wurden manuell festgelegt und werden bei einer
                KI-Neuanalyse nicht überschrieben.
              </span>
              <Button
                v-if="auth.hasPermission('documents.edit')"
                label="Wieder von KI bestimmen lassen"
                icon="pi pi-sparkles"
                size="small"
                severity="secondary"
                :loading="saving"
                @click="onUnpinAttributes"
              />
            </div>
          </Message>

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
            <Message
              v-if="doc.tax_reviewed"
              severity="info"
              :closable="false"
              icon="pi pi-lock"
              class="pinned-notice"
            >
              <div class="pinned-notice-body">
                <span>
                  Die Steuer-Zuordnung wurde manuell festgelegt und wird bei
                  KI-Neuanalysen nicht überschrieben.
                </span>
                <Button
                  v-if="auth.hasPermission('documents.edit')"
                  label="Wieder von KI bestimmen lassen"
                  icon="pi pi-sparkles"
                  size="small"
                  severity="secondary"
                  :loading="savingTax"
                  @click="onUnpinTax"
                />
              </div>
            </Message>
            <div v-if="doc.tax_review_needed" class="tax-review-hint">
              <i class="pi pi-question-circle" />
              <span>
                Betrifft eine Bezugsperson mit einer absetzbaren Position —
                bitte prüfen, ob <strong>du</strong> die Ausgabe getragen hast.
                Beim Bestätigen der Steuer-Zuordnung verschwindet dieser Hinweis.
              </span>
            </div>
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
          <div class="letterhead">
            <strong>Briefkopf (Bildmodell):</strong>
            <template v-if="doc.letterhead">
              <div class="letterhead__row">
                <span class="letterhead__label">Datum</span>
                <span v-if="doc.letterhead.date" class="letterhead__value">
                  {{ doc.letterhead.date.value }}
                  <Tag
                    :value="doc.letterhead.date.located ? 'belegt' : 'unbelegt'"
                    :severity="doc.letterhead.date.located ? 'success' : 'warn'"
                  />
                  <span class="letterhead__caption">
                    {{ doc.letterhead.date_label ?? 'ohne Beschriftung' }}
                  </span>
                </span>
                <span v-else class="letterhead__value letterhead__value--none">nichts gefunden</span>
              </div>
              <div class="letterhead__row">
                <span class="letterhead__label">Absender</span>
                <span v-if="doc.letterhead.sender" class="letterhead__value">
                  {{ doc.letterhead.sender.value }}
                  <Tag
                    :value="doc.letterhead.sender.located ? 'belegt' : 'unbelegt'"
                    :severity="doc.letterhead.sender.located ? 'success' : 'warn'"
                  />
                </span>
                <span v-else class="letterhead__value letterhead__value--none">nichts gefunden</span>
              </div>
              <div v-if="doc.letterhead.language" class="letterhead__row">
                <span class="letterhead__label">Sprache</span>
                <span class="letterhead__value">{{ doc.letterhead.language }}</span>
              </div>
              <p class="letterhead__hint">
                Was das Modell auf der Seite gelesen hat — noch nicht umgerechnet.
                „belegt“ heißt: der Text wurde in den OCR-Wörtern der Seite wiedergefunden.
                Ob der Wert auch übernommen wurde, entscheidet das Ranking gegen
                Textsuche und Klassifikation.
              </p>
            </template>
            <p v-else class="letterhead__hint">
              Für dieses Dokument nicht gelesen — es wurde extrahiert, bevor es diese
              Stufe gab. Eine erneute Textextraktion füllt die Werte.
            </p>
          </div>

          <div v-if="doc.extracted_text_preview" class="text-preview">
            <strong>{{ fullTextVisible ? 'Extrahierter Text (vollständig):' : 'Text-Vorschau:' }}</strong>
            <p :class="{ 'text-preview--full': fullTextVisible }">
              {{ fullTextVisible ? (fullText || doc.extracted_text_preview) : doc.extracted_text_preview }}
            </p>
            <Button
              :label="fullTextVisible ? 'Nur Vorschau anzeigen' : 'Vollständigen Text anzeigen'"
              :icon="fullTextVisible ? 'pi pi-angle-up' : 'pi pi-angle-down'"
              text
              size="small"
              :loading="fullTextLoading"
              @click="toggleFullText"
            />
          </div>
        </div>
      </div>
    </div>

    <DocumentFollowUpDialog
      v-if="doc"
      v-model:visible="followUpOpen"
      :document-ids="[doc.id]"
      @done="onFollowUpDone"
    />

    <Dialog
      v-model:visible="proposeOpen"
      modal
      header="Neue Kategorie vorschlagen"
      :style="{ width: '30rem', maxWidth: '95vw' }"
    >
      <div class="propose-dialog">
        <p class="propose-hint">
          Passt keine der vorhandenen Kategorien? Schlage eine neue vor — ein
          Administrator prüft den Vorschlag und legt die Kategorie ggf. an.
        </p>
        <label>
          <span class="label">Name der Kategorie</span>
          <InputText v-model="proposeName" placeholder="z. B. Vereinsbeiträge" />
        </label>
        <label>
          <span class="label">Oberkategorie (optional)</span>
          <Select
            v-model="proposeParentSlug"
            :options="parentCategoryOptions"
            optionLabel="label"
            optionValue="value"
          />
        </label>
        <label class="propose-checkbox">
          <Checkbox v-model="proposeMoveToSonstiges" :binary="true" inputId="propose-sonstiges" />
          <span>Dokument vorerst auf „Sonstiges" setzen</span>
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" text :disabled="proposing" @click="proposeOpen = false" />
        <Button
          label="Vorschlag einreichen"
          icon="pi pi-check"
          :loading="proposing"
          @click="onProposeCategory"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.document-detail-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  /* Without this any min-content blowout inside (long filename in
     extra-info, unbreakable text in the preview) can push the page
     past 100vw and produce horizontal scroll on the whole app. */
  max-width: 100%;
  min-width: 0;
  padding-inline: 0.5em;
  box-sizing: border-box;
}
/* The whole page is the only scroll container: neither the PDF
   preview nor the metadata pane has its own scrollbar. On wide
   viewports the panes still sit side by side via the grid below,
   they just grow with their content and the page scrolls if needed. */
@media (min-width: 800px) { .document-detail-view { padding-inline: 1em; } }

.propose-link {
  align-self: flex-start;
  margin-top: 0.25rem;
  padding-inline: 0;
}
.propose-dialog {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.propose-dialog .label {
  display: block;
  margin-bottom: 0.35rem;
}
.propose-dialog :deep(.p-inputtext),
.propose-dialog :deep(.p-select) {
  width: 100%;
}
.propose-hint {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}
.propose-checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.header-actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.basket-nav {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
}
.basket-nav-pos {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.linked-tx-section {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.6rem 0.75rem;
  background: color-mix(in srgb, var(--p-primary-color) 6%, transparent);
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
}
.linked-tx-list {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.linked-tx-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.linked-tx-btn { flex: 1; justify-content: flex-start; }

.help-flyout {
  max-width: min(22rem, 90vw);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.help-flyout__title {
  margin: 0;
  font-size: 0.95rem;
  color: var(--p-text-color);
}
.help-flyout__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.help-flyout__list li {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
}
.help-flyout__list i {
  color: var(--p-primary-color);
  flex-shrink: 0;
  width: 1.1rem;
  text-align: center;
  margin-top: 0.15rem;
}
.help-flyout__list strong {
  display: block;
  color: var(--p-text-color);
  font-size: 0.9rem;
}
.help-flyout__list span {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  line-height: 1.35;
}

/* On phones the four labelled buttons (Zurück / Neu klassifizieren /
   OCR erzwingen / Löschen) overflow the viewport. Hide the labels and
   tighten padding so the row stays icon-only and fits comfortably. */
@media (max-width: 640px) {
  .header :deep(.p-button-label) {
    display: none;
  }
  .header :deep(.p-button) {
    padding: 0.45rem 0.55rem;
  }
}

.info-text { text-align: center; margin-top: 4rem; color: var(--p-text-muted-color); }

.detail-grid {
  display: grid;
  /* `minmax(0, …)` instead of plain `1fr` so a grid item with wide
     min-content (e.g. an unbroken filename) cannot blow the track out
     past the container's width. */
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* ── Desktop: die Seite selbst scrollt nicht ────────────────────────────────
   Auf breiten Viewports füllt die Detailansicht exakt die Höhe unter der
   App-Navbar. Gescrollt wird ausschließlich *innerhalb* der beiden Panels:
   links Seite für Seite durch das PDF, rechts durch die Attribute. Kopfzeile
   und Menü bleiben dabei stehen. (#919)

   Der einzige Offset ist die Navbar: `#module-subheaders` ist auf dieser
   Route leer (die Ansicht teleportiert nichts dorthin) und `main.content`
   hat weder Padding noch Margin. */
@media (min-width: 1000px) {
  .document-detail-view {
    height: calc(100dvh - var(--menubar-height, 3.5rem));
    overflow: hidden;
  }
  .detail-grid {
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    min-height: 0;
  }
  .pdf-panel {
    min-height: 0;
    /* Der Seitenstapel scrollt im Viewer selbst, deshalb steht keine
       Navbar im Weg, wenn zu einer Seite gesprungen wird. */
    --pdf-scroll-margin: 0.5rem;
  }
}

.pdf-panel {
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  /* Clip the panel to its grid track so a wide (zoomed) page can't blow
     the column out past the container — the horizontal overflow is
     scrolled inside the viewer's canvas-wrapper instead. */
  overflow: hidden;
  display: flex;
  min-width: 0;
  /* Grows with the rendered PDF page; the surrounding page is the
     scroll container, not this panel. */
}

.meta-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  /* Prevent intrinsic min-content of children (long filename,
     unbroken text in extra-info / text-preview) from pushing the
     grid track wider than the container. */
  min-width: 0;
  padding-right: 0.25rem;
}

/* Eigener Scroll-Bereich neben dem PDF — siehe den Block weiter oben. */
@media (min-width: 1000px) {
  .meta-panel {
    min-height: 0;
    overflow-y: auto;
    /* Platz für die Scrollbar, damit sie nicht auf den Eingabefeldern liegt. */
    padding-right: 0.5rem;
  }
}

.meta-top {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
}
.doc-title { font-size: 1.25rem; font-weight: 600; flex: 1; min-width: 0; }

.replace-file-error {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.unlock-box {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.unlock-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
.unlock-row :deep(.p-inputtext) {
  flex: 1 1 12rem;
  min-width: 0;
}

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
.meta-form label,
.meta-form .meta-form-field { display: flex; flex-direction: column; gap: 0.25rem; }
.retention-hint {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  background: var(--p-content-hover-background);
  font-size: 0.85rem;
  color: var(--p-text-color);
}
.retention-hint .pi-clock { color: var(--p-text-muted-color); margin-top: 0.15rem; }
.retention-hint .retention-note {
  display: block;
  margin-top: 0.15rem;
  color: var(--p-text-muted-color);
}
.meta-form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.meta-form-row > label {
  flex: 1 1 12rem;
  min-width: 0;
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

.pinned-notice-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
}

.extra-info {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
  /* Long unbroken filenames must wrap, not push the column wider. */
  overflow-wrap: anywhere;
}
.letterhead {
  margin-bottom: 0.75rem;
}

.letterhead__row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  margin-top: 0.25rem;
  font-size: 0.85rem;
}

.letterhead__label {
  flex: 0 0 5.5rem;
  color: var(--p-text-muted-color);
}

.letterhead__value {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}

.letterhead__caption {
  color: var(--p-text-muted-color);
  font-size: 0.75rem;
}

.letterhead__value--none {
  color: var(--p-text-muted-color);
  font-style: italic;
}

.letterhead__hint {
  margin: 0.4rem 0 0;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
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
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow-y: auto;
}
/* Expanded full text gets more room but stays its own scroll container so
   the page never grows by tens of thousands of pixels. */
.text-preview p.text-preview--full {
  max-height: 60vh;
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

.tax-review-hint {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  font-size: 0.85rem;
  color: var(--p-text-color);
}
.tax-review-hint .pi {
  color: var(--p-primary-color);
  margin-top: 0.1rem;
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
