<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Drawer from 'primevue/drawer'
import Message from 'primevue/message'
import { useTxSelectionStore } from '../../stores/finance/selection'
import { downloadTransactionsCsv, suggestDocumentsForTransactions, decideDocumentMatch, getDocumentMatchMetrics, linkDocumentsToTransactions, type DocumentMatchSuggestion, type Transaction } from '../../api/finance'
import BatchTagDialog from './BatchTagDialog.vue'
import BatchNoticeDialog from './BatchNoticeDialog.vue'
import { searchDocuments, type DocumentSummary } from '../../api/documents'
import { basketTags, basketCounterparties, basketMonths, hasMixedCurrencies, type BasketAggregate } from '../../utils/financeBasketAnalysis'

/**
 * Header indicator + slide-out drawer for the transaction basket.
 *
 * Surfaces the current selection regardless of which view created it so
 * the user can review and act on it without going back to the list.
 * Mounted from App.vue's navbar-end only while the user is in the
 * finance module — other modules don't use the basket.
 */

const selectionStore = useTxSelectionStore()
const drawerVisible = ref(false)
const tagDialogVisible = ref(false)
const noticeDialogVisible = ref(false)
const exporting = ref(false)
const actionError = ref<string | null>(null)
const actionInfo = ref<string | null>(null)
const documentSuggestions = ref<DocumentMatchSuggestion[]>([])
const loadingSuggestions = ref(false)
const documentQuery = ref('')
const documentResults = ref<DocumentSummary[]>([])
const manualLinkOpen = ref(false)
const matchMetrics = ref<{ high: Record<string, number>; medium: Record<string, number>; low: Record<string, number> } | null>(null)
const analysisView = ref<'tags' | 'counterparties' | 'months'>('tags')

const count = computed(() => selectionStore.count)
const items = computed(() => selectionStore.items)
const analysisRows = computed<BasketAggregate[]>(() => analysisView.value === 'tags' ? basketTags(items.value) : analysisView.value === 'counterparties' ? basketCounterparties(items.value) : basketMonths(items.value))
const mixedCurrencies = computed(() => hasMixedCurrencies(items.value))

const sumLabel = computed(() => {
  if (count.value === 0) return ''
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: selectionStore.currency,
  }).format(selectionStore.sum)
})

function formatAmount(tx: Transaction): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: tx.currency_code,
  }).format(Number(tx.amount))
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
  if (count.value === 0 || exporting.value) return
  actionError.value = null
  exporting.value = true
  try {
    await downloadTransactionsCsv(selectionStore.ids)
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    exporting.value = false
  }
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
          <span class="drawer-title">Basket</span>
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
          <div class="action-row">
            <Button
              label="Tags"
              icon="pi pi-tag"
              size="small"
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
              :loading="exporting"
              @click="exportCsv"
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

    <BatchTagDialog v-model:visible="tagDialogVisible" />
    <BatchNoticeDialog
      v-model:visible="noticeDialogVisible"
      :transaction-ids="selectionStore.ids"
    />
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
.drawer-sum {
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
.clear-row {
  display: flex;
  justify-content: flex-end;
}
</style>
