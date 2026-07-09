<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import Drawer from 'primevue/drawer'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Checkbox from 'primevue/checkbox'
import { useConfirm } from 'primevue/useconfirm'
import { useTxSelectionStore } from '../../stores/finance/selection'
import { useTagsStore } from '../../stores/finance/tags'
import { batchReview, batchTaxRelevant, deleteBasketSnapshot, downloadTransactionsCsv, downloadTransactionsPdf, getTransaction, getTransactionSplits, listBasketSnapshots, loadBasketSnapshot, mergeCounterparties, saveBasketSnapshot, setTransactionSplits, suggestDocumentsForTransactions, decideDocumentMatch, getDocumentMatchMetrics, linkDocumentsToTransactions, type BasketSnapshot, type DocumentMatchSuggestion, type Transaction, type TransactionPdfExportOptions } from '../../api/finance'
import BatchTagDialog from './BatchTagDialog.vue'
import BatchNoticeDialog from './BatchNoticeDialog.vue'
import TagAutoComplete from './TagAutoComplete.vue'
import { searchDocuments, type DocumentSummary } from '../../api/documents'
import { basketTags, basketCounterparties, basketMonths, hasMixedCurrencies, type BasketAggregate } from '../../utils/financeBasketAnalysis'
import { detectRecurringSelection } from '../../utils/financeRecurringSelection'
import { compareBasketCounterparties } from '../../utils/financeBasketCompare'

/**
 * Header indicator + slide-out drawer for the transaction basket.
 *
 * Surfaces the current selection regardless of which view created it so
 * the user can review and act on it without going back to the list.
 * Mounted from App.vue's navbar-end only while the user is in the
 * finance module — other modules don't use the basket.
 */

const selectionStore = useTxSelectionStore()
const tagsStore = useTagsStore()
const confirm = useConfirm()
const drawerVisible = ref(false)
const tagDialogVisible = ref(false)
const noticeDialogVisible = ref(false)
const csvExporting = ref(false)
const pdfExporting = ref(false)
const actionError = ref<string | null>(null)
const actionInfo = ref<string | null>(null)
const documentSuggestions = ref<DocumentMatchSuggestion[]>([])
const loadingSuggestions = ref(false)
const documentQuery = ref('')
const documentResults = ref<DocumentSummary[]>([])
const manualLinkOpen = ref(false)
const matchMetrics = ref<{ high: Record<string, number>; medium: Record<string, number>; low: Record<string, number> } | null>(null)
const analysisView = ref<'tags' | 'counterparties' | 'months'>('tags')
const batchBusy = ref(false)
const counterpartyDialogVisible = ref(false)
const canonicalCounterparty = ref('')
const canonicalIban = ref('')
const canonicalBic = ref('')
const snapshotDialogVisible = ref(false)
const snapshotLoading = ref(false)
const snapshotError = ref<string | null>(null)
const snapshots = ref<BasketSnapshot[]>([])
const snapshotName = ref('')
const selectedSnapshotId = ref<number | null>(null)
const activeBasketName = ref<string | null>(null)
const compareDialogVisible = ref(false)
const compareA = ref<number | null>(null)
const compareB = ref<number | null>(null)
const comparisonRows = ref<Array<{ label: string; a: number; b: number }>>([])
const comparisonCurrencyMismatch = ref(false)
const splitDialogVisible = ref(false)
const splitLoading = ref(false)
const splitError = ref<string | null>(null)
const editingExistingSplit = ref(false)
const splitRows = ref<Array<{ amount: number; tags: string[]; notice: string; is_tax_relevant: boolean }>>([])
const pdfDialogVisible = ref(false)
const pdfTitle = ref('Transaktionsübersicht')
const pdfExportOptions = ref<TransactionPdfExportOptions>({
  title: 'Transaktionsübersicht',
  includeDate: true,
  includeCounterparty: true,
  includePurpose: true,
  includeAmount: true,
  includeNotice: true,
  includeTags: true,
})

const count = computed(() => selectionStore.count)
const items = computed(() => selectionStore.items)
const analysisRows = computed<BasketAggregate[]>(() => analysisView.value === 'tags' ? basketTags(items.value) : analysisView.value === 'counterparties' ? basketCounterparties(items.value) : basketMonths(items.value))
const mixedCurrencies = computed(() => hasMixedCurrencies(items.value))
const recurringGroups = computed(() => detectRecurringSelection(items.value))
const majorityReviewed = computed(() => items.value.filter(item => !!item.reviewed_at).length > items.value.length / 2)
const majorityTaxRelevant = computed(() => items.value.filter(item => !!item.is_tax_relevant).length > items.value.length / 2)
const drawerTitle = computed(() => count.value > 0 ? activeBasketName.value || 'Basket' : 'Basket')
const sumLabel = computed(() => {
  if (count.value === 0) return ''
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: selectionStore.currency,
  }).format(selectionStore.sum)
})

watch(count, (next) => {
  if (next === 0) activeBasketName.value = null
})

function formatAmount(tx: Transaction): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: tx.currency_code,
  }).format(Number(tx.amount))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function formatAnalysisAmount(amount: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: selectionStore.currency }).format(amount)
}

function monthLabel(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return month
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })
}

function openManualLink() {
  manualLinkOpen.value = true
  actionError.value = null
}

async function searchBasketDocuments() {
  const query = documentQuery.value.trim()
  if (!query) { actionError.value = 'Bitte einen Suchbegriff für das Dokument eingeben.'; return }
  actionError.value = null
  actionInfo.value = null
  try {
    documentResults.value = (await searchDocuments(query)).items
  } catch (err) {
    actionError.value = `Dokumentsuche konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`
  }
}
async function linkDocument(documentId: number) {
  try {
    actionError.value = null
    const result = await linkDocumentsToTransactions(selectionStore.ids, [documentId])
    documentResults.value = documentResults.value.filter(d => d.id !== documentId)
    actionInfo.value = `${result.linked} Verknüpfung${result.linked === 1 ? '' : 'en'} erstellt.`
  } catch (err) { actionError.value = err instanceof Error ? err.message : String(err) }
}

async function loadDocumentSuggestions() {
  if (!count.value || loadingSuggestions.value) return
  loadingSuggestions.value = true
  try { documentSuggestions.value = await suggestDocumentsForTransactions(selectionStore.ids) }
  catch (err) { actionError.value = `Belegvorschläge konnten nicht geladen werden: ${err instanceof Error ? err.message : String(err)}` }
  finally { loadingSuggestions.value = false }
  matchMetrics.value = await getDocumentMatchMetrics().catch(() => null)
}
async function decideSuggestion(suggestion: DocumentMatchSuggestion, outcome: 'accepted' | 'rejected') {
  await decideDocumentMatch(suggestion.id, outcome)
  documentSuggestions.value = documentSuggestions.value.filter(item => item.id !== suggestion.id)
}

function openBatchTagEditor() {
  if (count.value === 0) return
  actionError.value = null
  tagDialogVisible.value = true
}

function openBatchNoticeEditor() {
  if (count.value === 0) return
  actionError.value = null
  noticeDialogVisible.value = true
}

async function exportCsv() {
  if (count.value === 0 || csvExporting.value) return
  actionError.value = null
  csvExporting.value = true
  try {
    await downloadTransactionsCsv(selectionStore.ids)
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    csvExporting.value = false
  }
}

function openPdfDialog() {
  if (!count.value) return
  actionError.value = null
  pdfDialogVisible.value = true
}

async function exportPdf() {
  if (!count.value || pdfExporting.value) return
  pdfExporting.value = true
  try {
    await downloadTransactionsPdf(selectionStore.ids, {
      ...pdfExportOptions.value,
      title: pdfTitle.value.trim() || 'Transaktionsübersicht',
    })
    pdfDialogVisible.value = false
  }
  catch (err) { actionError.value = err instanceof Error ? err.message : String(err) }
  finally { pdfExporting.value = false }
}

async function applyBatchFlag(kind: 'reviewed' | 'tax', value: boolean) {
  if (!count.value || batchBusy.value) return
  batchBusy.value = true
  actionError.value = null
  try {
    const result = kind === 'reviewed'
      ? await batchReview(selectionStore.ids, value)
      : await batchTaxRelevant(selectionStore.ids, value)
    selectionStore.set(items.value.map(item => kind === 'reviewed'
      ? { ...item, reviewed_at: value ? new Date().toISOString() : null }
      : { ...item, is_tax_relevant: value }))
    actionInfo.value = `${result.affected_transactions} Buchung${result.affected_transactions === 1 ? '' : 'en'} aktualisiert.`
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    batchBusy.value = false
  }
}

function toggleTaxRelevant() {
  const value = !majorityTaxRelevant.value
  confirm.require({
    header: 'Steuerrelevanz ändern',
    message: `${count.value} Buchungen → ${value ? 'steuerrelevant' : 'nicht steuerrelevant'}`,
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Übernehmen',
    accept: () => void applyBatchFlag('tax', value),
  })
}

function openCounterpartyMerge() {
  const names = items.value.map(item => item.counterparty?.trim()).filter((value): value is string => !!value)
  canonicalCounterparty.value = names.sort((a, b) => names.filter(n => n === b).length - names.filter(n => n === a).length)[0] ?? ''
  canonicalIban.value = items.value.find(item => item.counterparty_iban)?.counterparty_iban ?? ''
  canonicalBic.value = items.value.find(item => item.counterparty_bic)?.counterparty_bic ?? ''
  counterpartyDialogVisible.value = true
}

async function saveCounterpartyMerge() {
  if (!canonicalCounterparty.value.trim() || batchBusy.value) return
  batchBusy.value = true
  try {
    const result = await mergeCounterparties({
      transaction_ids: selectionStore.ids,
      canonical_name: canonicalCounterparty.value,
      set_iban: canonicalIban.value || undefined,
      set_bic: canonicalBic.value || undefined,
    })
    selectionStore.set(items.value.map(item => ({
      ...item,
      counterparty: canonicalCounterparty.value.trim(),
      ...(canonicalIban.value ? { counterparty_iban: canonicalIban.value.trim() } : {}),
      ...(canonicalBic.value ? { counterparty_bic: canonicalBic.value.trim() } : {}),
    })))
    actionInfo.value = `${result.affected_transactions} Gegenseiten vereinheitlicht.`
    counterpartyDialogVisible.value = false
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    batchBusy.value = false
  }
}

async function refreshSnapshots() {
  snapshots.value = (await listBasketSnapshots()).items
}

async function openSnapshots() {
  actionError.value = null
  snapshotError.value = null
  snapshotDialogVisible.value = true
  snapshotLoading.value = true
  try {
    await refreshSnapshots()
  } catch (err) {
    snapshotError.value = errorMessage(err)
  } finally {
    snapshotLoading.value = false
  }
}

async function saveSnapshot() {
  if (!snapshotName.value.trim()) return
  const existing = snapshots.value.find(snapshot => snapshot.name.toLocaleLowerCase() === snapshotName.value.trim().toLocaleLowerCase())
  const execute = async () => {
    const saved = await saveBasketSnapshot(snapshotName.value, selectionStore.ids)
    await refreshSnapshots()
    activeBasketName.value = saved.name
    actionInfo.value = existing ? 'Basket überschrieben.' : 'Basket gespeichert.'
  }
  if (!existing) { await execute(); return }
  confirm.require({
    header: 'Basket überschreiben?',
    message: `„${existing.name}“ wird durch die aktuelle Auswahl ersetzt.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Überschreiben',
    rejectLabel: 'Abbrechen',
    accept: () => { void execute() },
  })
}

async function loadSnapshot() {
  if (!selectedSnapshotId.value) return
  const snapshot = await loadBasketSnapshot(selectedSnapshotId.value)
  const loaded = await Promise.all(snapshot.transaction_ids.map(id => getTransaction(id)))
  selectionStore.set(loaded)
  activeBasketName.value = snapshot.name
  actionInfo.value = snapshot.missing ? `${snapshot.missing} nicht mehr verfügbare Buchungen wurden übersprungen.` : 'Basket geladen.'
  snapshotDialogVisible.value = false
}

function clearBasket() {
  selectionStore.clear()
  activeBasketName.value = null
}

async function removeSnapshot() {
  if (!selectedSnapshotId.value) return
  const selected = snapshots.value.find(snapshot => snapshot.id === selectedSnapshotId.value)
  confirm.require({
    header: 'Basket löschen?',
    message: `„${selected?.name ?? 'Basket'}“ wird dauerhaft gelöscht.`,
    icon: 'pi pi-trash',
    acceptLabel: 'Löschen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: () => { void (async () => {
      await deleteBasketSnapshot(selectedSnapshotId.value!)
      selectedSnapshotId.value = null
      await refreshSnapshots()
    })() },
  })
}

async function compareSnapshots() {
  if (!compareA.value || !compareB.value) return
  const [a, b] = await Promise.all([loadBasketSnapshot(compareA.value), loadBasketSnapshot(compareB.value)])
  const [aItems, bItems] = await Promise.all([
    Promise.all(a.transaction_ids.map(id => getTransaction(id))),
    Promise.all(b.transaction_ids.map(id => getTransaction(id))),
  ])
  const comparison = compareBasketCounterparties(aItems, bItems)
  comparisonCurrencyMismatch.value = comparison.currencyMismatch
  comparisonRows.value = comparison.rows
}

async function openSplit() {
  const amount = Number(items.value[0]?.amount ?? 0)
  const transactionId = items.value[0]?.id
  splitError.value = null
  if (tagsStore.items.length === 0) {
    void tagsStore.refresh('user').catch(() => {})
  }
  editingExistingSplit.value = false
  const first = Math.round(amount * 50) / 100
  splitRows.value = [
    { amount: first, tags: [], notice: '', is_tax_relevant: false },
    { amount: Math.round((amount - first) * 100) / 100, tags: [], notice: '', is_tax_relevant: false },
  ]
  splitDialogVisible.value = true

  if (transactionId) {
    splitLoading.value = true
    try {
      const existing = await getTransactionSplits(transactionId)
      if (existing.items.length) {
        editingExistingSplit.value = true
        splitRows.value = existing.items.map(row => ({
          amount: Number(row.amount),
          tags: [...row.tags],
          notice: row.notice ?? '',
          is_tax_relevant: !!row.is_tax_relevant,
        }))
      }
    } catch (err) {
      splitError.value = errorMessage(err)
    } finally {
      splitLoading.value = false
    }
  }
}

const splitDifference = computed(() => Number(items.value[0]?.amount ?? 0) - splitRows.value.reduce((sum, row) => sum + Number(row.amount || 0), 0))
async function saveSplit() {
  const tx = items.value[0]
  if (!tx || Math.abs(splitDifference.value) >= 0.005) return
  const rows = splitRows.value.map(row => ({
    ...row,
    tags: row.tags.map(tag => tag.trim()).filter(Boolean),
  }))
  await setTransactionSplits(tx.id, rows)
  tagsStore.addLocal(rows.flatMap(row => row.tags))
  splitDialogVisible.value = false
  actionInfo.value = 'Split-Buchung gespeichert.'
}

</script>

<template>
  <div class="basket-indicator">
    <Button
      v-tooltip.bottom="count === 0 ? 'Basket (leer)' : `Basket · ${count} Buchung${count === 1 ? '' : 'en'}`"
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

    <Drawer
      v-model:visible="drawerVisible"
      position="right"
      header="Basket"
      class="basket-drawer"
    >
      <template #header>
        <div class="drawer-header">
          <span class="drawer-title" :title="drawerTitle">{{ drawerTitle }}</span>
          <span v-if="count > 0" class="drawer-sum">{{ sumLabel }}</span>
        </div>
      </template>

      <div v-if="count === 0" class="basket-empty">
        <i class="pi pi-shopping-cart basket-empty-icon" />
        <p>Noch keine Buchungen im Basket.</p>
        <p class="hint">
          Lege Buchungen aus der Liste, der Detailansicht oder den Anomalien
          ab, um sie hier zu sammeln.
        </p>
      </div>

      <div v-else>
      <section class="basket-matches">
        <div class="basket-match-actions">
          <Button label="Verknüpfen" icon="pi pi-link" size="small" @click="openManualLink" />
          <Button label="Vorschläge" icon="pi pi-file" size="small" outlined :loading="loadingSuggestions" @click="loadDocumentSuggestions" />
        </div>
        <div v-if="manualLinkOpen" class="basket-document-search">
          <InputText v-model="documentQuery" placeholder="Dokument suchen" @keyup.enter="searchBasketDocuments" />
          <Button icon="pi pi-search" size="small" aria-label="Dokument suchen" @click="searchBasketDocuments" />
        </div>
        <p v-for="document in documentResults" :key="document.id" class="basket-document-result">
          {{ document.title ?? document.original_filename }}
          <Button label="Verbinden" size="small" text @click="linkDocument(document.id)" />
        </p>
        <p v-for="suggestion in documentSuggestions" :key="suggestion.id">
          Beleg #{{ suggestion.document_id }} · {{ Math.round(suggestion.score * 100) }}%
          <Button label="Annehmen" size="small" text @click="decideSuggestion(suggestion, 'accepted')" />
          <Button label="Ablehnen" size="small" text @click="decideSuggestion(suggestion, 'rejected')" />
        </p>
        <p v-if="matchMetrics" class="basket-match-metrics">Trefferquote (hoch): {{ matchMetrics.high.accepted }} angenommen / {{ matchMetrics.high.rejected }} abgelehnt</p>
      </section>
      <ul class="basket-list">
        <section class="basket-analysis" aria-label="Auswertung der Auswahl">
          <div class="basket-analysis-tabs" role="tablist" aria-label="Auswertung gruppieren nach">
            <button v-for="view in [{ id: 'tags', label: 'Tags' }, { id: 'counterparties', label: 'Gegenseite' }, { id: 'months', label: 'Monat' }]" :key="view.id" type="button" class="basket-analysis-tab" :class="{ active: analysisView === view.id }" @click="analysisView = view.id as 'tags' | 'counterparties' | 'months'">{{ view.label }}</button>
          </div>
          <p v-if="mixedCurrencies" class="basket-analysis-hint">Mehrere Währungen: Summen werden in der Basket-Währung angezeigt.</p>
          <ul class="basket-analysis-list">
            <li v-for="row in analysisRows" :key="row.label" class="basket-analysis-row">
              <span>{{ analysisView === 'months' ? monthLabel(row.label) : row.label }} <small v-if="row.aiOnly" class="ai-tag">KI</small><small>· {{ row.count }}</small></span>
              <strong :class="row.amount < 0 ? 'amount-neg' : 'amount-pos'">{{ formatAnalysisAmount(row.amount) }}</strong>
            </li>
          </ul>
        </section>
        <section v-if="recurringGroups.length" class="basket-analysis" aria-label="Wiederkehrende Buchungen">
          <strong>Wiederkehrende in der Auswahl</strong>
          <ul class="basket-analysis-list">
            <li v-for="group in recurringGroups" :key="`${group.counterparty}-${group.averageIntervalDays}`" class="basket-analysis-row">
              <span>{{ group.counterparty }} <small>· {{ group.count }}×</small></span>
              <span>Ø {{ group.averageIntervalDays }} Tage</span>
            </li>
          </ul>
        </section>
        <li
          v-for="tx in items"
          :key="tx.id"
          class="basket-row"
        >
          <div class="basket-row-body">
            <div class="basket-row-head">
              <span class="basket-row-date">{{ formatDate(tx.booking_date) }}</span>
              <span
                class="basket-row-amount"
                :class="Number(tx.amount) < 0 ? 'amount-neg' : 'amount-pos'"
              >
                {{ formatAmount(tx) }}
              </span>
            </div>
            <div class="basket-row-name">
              {{ tx.counterparty ?? '—' }}
            </div>
            <div v-if="tx.purpose" class="basket-row-purpose">
              {{ tx.purpose }}
            </div>
          </div>
          <button
            type="button"
            class="basket-row-remove"
            :aria-label="`Aus Basket entfernen: ${tx.counterparty ?? tx.id}`"
            @click="selectionStore.remove(tx.id)"
          >
            <i class="pi pi-times-circle" />
          </button>
        </li>
      </ul>
      </div>

      <template #footer>
        <div class="drawer-footer">
          <Message v-if="actionInfo" severity="success" :closable="true" class="action-error" @close="actionInfo = null">{{ actionInfo }}</Message>
          <Message
            v-if="actionError"
            severity="error"
            :closable="true"
            class="action-error"
            @close="actionError = null"
          >
            {{ actionError }}
          </Message>
          <div class="drawer-actions">
            <Button
              :label="majorityReviewed ? 'Prüfvermerk entfernen' : 'Als geprüft markieren'"
              icon="pi pi-check-circle"
              size="small"
              severity="secondary"
              outlined
              :loading="batchBusy"
              @click="applyBatchFlag('reviewed', !majorityReviewed)"
            />
            <Button label="Steuerrelevant" icon="pi pi-percentage" size="small" severity="secondary" outlined :loading="batchBusy" @click="toggleTaxRelevant" />
            <Button label="Gegenseite" icon="pi pi-users" size="small" severity="secondary" outlined :disabled="count === 0" @click="openCounterpartyMerge" />
            <Button label="Split" icon="pi pi-sitemap" size="small" severity="secondary" outlined :disabled="count !== 1" :loading="splitLoading" @click="openSplit" />
            <Button label="Baskets" icon="pi pi-save" size="small" severity="secondary" outlined :loading="snapshotLoading" @click="openSnapshots" />
            <Button
              label="Tags"
              icon="pi pi-tag"
              size="small"
              severity="secondary"
              outlined
              :disabled="count === 0"
              @click="openBatchTagEditor"
            />
            <Button
              label="Notiz"
              icon="pi pi-comment"
              size="small"
              severity="secondary"
              outlined
              :disabled="count === 0"
              @click="openBatchNoticeEditor"
            />
            <Button
              label="CSV"
              icon="pi pi-download"
              size="small"
              severity="secondary"
              outlined
              :disabled="count === 0"
              :loading="csvExporting"
              @click="exportCsv"
            />
            <Button label="PDF" icon="pi pi-file-pdf" size="small" severity="secondary" outlined :disabled="count === 0" :loading="pdfExporting" @click="openPdfDialog" />
          </div>
          <div class="clear-row">
            <Button
              label="Alles leeren"
              icon="pi pi-times"
              severity="secondary"
              text
              size="small"
              :disabled="count === 0"
              @click="clearBasket"
            />
          </div>
        </div>
      </template>
    </Drawer>

    <BatchTagDialog v-model:visible="tagDialogVisible" />
    <BatchNoticeDialog
      v-model:visible="noticeDialogVisible"
      :transaction-ids="selectionStore.ids"
    />
    <Dialog v-model:visible="counterpartyDialogVisible" header="Gegenseiten vereinheitlichen" modal :style="{ width: 'min(30rem, calc(100vw - 2rem))' }">
      <div class="counterparty-form">
        <label>Kanonischer Name<InputText v-model="canonicalCounterparty" /></label>
        <label>IBAN nachziehen (optional)<InputText v-model="canonicalIban" /></label>
        <label>BIC nachziehen (optional)<InputText v-model="canonicalBic" /></label>
        <strong>Vorschau</strong>
        <ul class="basket-analysis-list"><li v-for="tx in items" :key="tx.id" class="basket-analysis-row"><span>{{ tx.counterparty ?? '—' }}</span><span>→ {{ canonicalCounterparty || '—' }}</span></li></ul>
      </div>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="counterpartyDialogVisible = false" />
        <Button label="Vereinheitlichen" icon="pi pi-check" :loading="batchBusy" :disabled="!canonicalCounterparty.trim()" @click="saveCounterpartyMerge" />
      </template>
    </Dialog>
    <Dialog v-model:visible="snapshotDialogVisible" header="Benannte Baskets" modal :style="{ width: 'min(34rem, calc(100vw - 2rem))' }">
      <div class="counterparty-form">
        <Message v-if="snapshotLoading" severity="info" :closable="false">Gespeicherte Baskets werden geladen…</Message>
        <Message v-if="snapshotError" severity="error" :closable="false">Baskets konnten nicht geladen werden: {{ snapshotError }}</Message>
        <label>Aktuellen Basket speichern<InputText v-model="snapshotName" placeholder="Name" /></label>
        <Button label="Speichern / überschreiben" icon="pi pi-save" :disabled="!snapshotName.trim() || count === 0" @click="saveSnapshot" />
        <label>Gespeicherter Basket<Select v-model="selectedSnapshotId" :options="snapshots" option-label="name" option-value="id" placeholder="Basket wählen" /></label>
        <div class="action-row"><Button label="Laden" :disabled="!selectedSnapshotId" @click="loadSnapshot" /><Button label="Löschen" severity="danger" outlined :disabled="!selectedSnapshotId" @click="removeSnapshot" /></div>
        <Button label="Baskets vergleichen" icon="pi pi-chart-bar" outlined :disabled="snapshots.length < 2" @click="compareDialogVisible = true" />
      </div>
    </Dialog>
    <Dialog v-model:visible="compareDialogVisible" header="Basket-Vergleich nach Gegenseite" modal :style="{ width: 'min(42rem, calc(100vw - 2rem))' }">
      <div class="basket-match-actions"><Select v-model="compareA" :options="snapshots" option-label="name" option-value="id" placeholder="Basket A" /><Select v-model="compareB" :options="snapshots" option-label="name" option-value="id" placeholder="Basket B" /></div>
      <Button label="Vergleichen" :disabled="!compareA || !compareB || compareA === compareB" @click="compareSnapshots" />
      <Message v-if="comparisonCurrencyMismatch" severity="warn" :closable="false">Die Baskets enthalten unterschiedliche Währungen; es wird keine irreführende Gesamtsumme gebildet.</Message>
      <ul class="basket-analysis-list"><li v-for="row in comparisonRows" :key="row.label" class="basket-analysis-row"><span>{{ row.label }}</span><span>{{ formatAnalysisAmount(row.a) }} → {{ formatAnalysisAmount(row.b) }} (Δ {{ formatAnalysisAmount(row.b - row.a) }})</span></li></ul>
    </Dialog>
    <Dialog v-model:visible="splitDialogVisible" header="Buchung aufteilen" modal :style="{ width: 'min(42rem, calc(100vw - 2rem))' }">
      <div class="counterparty-form">
        <Message v-if="splitLoading" severity="info" :closable="false">Vorhandene Split-Aufteilung wird geladen…</Message>
        <Message v-if="splitError" severity="warn" :closable="false">Vorhandene Split-Aufteilung konnte nicht geladen werden: {{ splitError }}</Message>
        <Message v-if="editingExistingSplit" severity="info" :closable="false">Diese Buchung besitzt bereits einen Split. Speichern ersetzt die bestehende Aufteilung vollständig.</Message>
        <div v-for="(row, index) in splitRows" :key="index" class="split-row">
          <InputNumber v-model="row.amount" mode="currency" :currency="items[0]?.currency_code ?? 'EUR'" locale="de-DE" />
          <TagAutoComplete v-model="row.tags" placeholder="Tags" />
          <InputText v-model="row.notice" placeholder="Notiz" />
          <label class="split-tax"><Checkbox v-model="row.is_tax_relevant" binary /> Steuerrelevant</label>
          <Button v-if="splitRows.length > 2" icon="pi pi-trash" text severity="danger" @click="splitRows.splice(index, 1)" />
        </div>
        <Button label="Teil hinzufügen" icon="pi pi-plus" text @click="splitRows.push({ amount: 0, tags: [], notice: '', is_tax_relevant: false })" />
        <Message :severity="Math.abs(splitDifference) < .005 ? 'success' : 'warn'" :closable="false">Differenz: {{ formatAnalysisAmount(splitDifference) }}</Message>
      </div>
      <template #footer><Button label="Abbrechen" text @click="splitDialogVisible = false" /><Button label="Speichern" :disabled="Math.abs(splitDifference) >= .005" @click="saveSplit" /></template>
    </Dialog>
    <Dialog v-model:visible="pdfDialogVisible" header="PDF exportieren" modal :style="{ width: 'min(32rem, calc(100vw - 2rem))' }">
      <div class="counterparty-form">
        <label>
          Überschrift
          <InputText v-model="pdfTitle" placeholder="Transaktionsübersicht" />
        </label>
        <div class="pdf-options" aria-label="Attribute im PDF">
          <label><Checkbox v-model="pdfExportOptions.includeDate" binary /> Datum</label>
          <label><Checkbox v-model="pdfExportOptions.includeCounterparty" binary /> Gegenseite</label>
          <label><Checkbox v-model="pdfExportOptions.includePurpose" binary /> Verwendungszweck</label>
          <label><Checkbox v-model="pdfExportOptions.includeAmount" binary /> Betrag</label>
          <label><Checkbox v-model="pdfExportOptions.includeNotice" binary /> Notiz</label>
          <label><Checkbox v-model="pdfExportOptions.includeTags" binary /> Tags</label>
        </div>
      </div>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="pdfDialogVisible = false" />
        <Button label="PDF erstellen" icon="pi pi-file-pdf" :loading="pdfExporting" :disabled="count === 0" @click="exportPdf" />
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
  min-width: 0;
  width: 100%;
}
.drawer-title {
  flex: 1 1 auto;
  font-weight: 600;
  font-size: 1.05rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drawer-sum {
  flex: 0 0 auto;
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
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
.counterparty-form { display: grid; gap: .85rem; }
.counterparty-form label { display: grid; gap: .35rem; font-weight: 600; }
.counterparty-form :deep(.p-inputtext) { width: 100%; }
.pdf-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: .6rem .85rem;
}
.counterparty-form .pdf-options label {
  display: flex;
  align-items: center;
  gap: .5rem;
  font-weight: 500;
}
.split-row { display: grid; grid-template-columns: minmax(8rem, .7fr) minmax(9rem, 1fr) minmax(9rem, 1fr) auto; gap: .5rem; align-items: center; }
@media (max-width: 620px) {
  .split-row { grid-template-columns: 1fr; }
}

.basket-match-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .5rem; margin-bottom: .5rem; }
.basket-match-actions :deep(.p-button) { min-width: 0; }
.basket-match-actions :deep(.p-button-label) { overflow: hidden; text-overflow: ellipsis; }
.basket-document-search { display: flex; gap: .5rem; margin-bottom: .5rem; min-width: 0; }
.basket-document-search :deep(.p-inputtext) { flex: 1; min-width: 0; }
.basket-document-search :deep(.p-button) { flex-shrink: 0; }
.basket-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}
.basket-analysis { margin: 0 0 .75rem; padding: .6rem; border: 1px solid var(--p-content-border-color); border-radius: .4rem; }
.basket-analysis-tabs { display: flex; gap: .25rem; margin-bottom: .5rem; }
.basket-analysis-tab { border: 0; border-radius: .3rem; background: transparent; padding: .25rem .45rem; cursor: pointer; color: var(--p-text-muted-color); }
.basket-analysis-tab.active { color: var(--p-primary-color); background: var(--p-highlight-background); font-weight: 600; }
.basket-analysis-list { list-style: none; padding: 0; margin: 0; }
.basket-analysis-row { display: flex; justify-content: space-between; gap: .5rem; padding: .18rem 0; font-size: .85rem; }
.basket-analysis-row small { color: var(--p-text-muted-color); }
.basket-analysis-hint { margin: 0 0 .4rem; color: var(--p-text-muted-color); font-size: .78rem; }
.ai-tag { color: var(--p-primary-color) !important; }
.basket-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.6rem 0.25rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.basket-row:last-child {
  border-bottom: none;
}
.basket-row-body {
  flex: 1;
  min-width: 0;
}
.basket-row-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.basket-row-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.basket-row-amount {
  font-family: monospace;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.amount-pos { color: var(--p-text-color); }
.amount-neg { color: var(--p-red-600, #c0392b); }
.basket-row-name {
  margin-top: 0.15rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.basket-row-purpose {
  margin-top: 0.1rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.action-error {
  margin: 0;
}
.action-row {
  display: flex;
  gap: 0.5rem;
}
.action-row :deep(.p-button) {
  flex: 1;
}
.drawer-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6.75rem, 1fr));
  gap: 0.4rem;
  width: 100%;
}
.drawer-actions :deep(.p-button) {
  width: 100%;
  min-width: 0;
  min-height: 2.25rem;
  justify-content: center;
  padding-inline: 0.55rem;
}
.drawer-actions :deep(.p-button-label) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clear-row {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 520px) {
  .drawer-actions {
    grid-template-columns: repeat(5, minmax(2.5rem, 1fr));
    gap: 0.35rem;
  }

  .drawer-actions :deep(.p-button) {
    min-height: 2.35rem;
    padding-inline: 0.35rem;
  }

  .drawer-actions :deep(.p-button-label) {
    display: none;
  }
}
</style>
