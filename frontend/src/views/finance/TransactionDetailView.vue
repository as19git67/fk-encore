<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'
import TagAutoComplete from '../../components/finance/TagAutoComplete.vue'
import Textarea from 'primevue/textarea'
import Dialog from 'primevue/dialog'
import { useConfirm } from 'primevue/useconfirm'
import { toLocalIsoDate } from '../../utils/dateFormat'
import { useModuleBack } from '../../composables/useModuleBack'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTagsStore } from '../../stores/finance/tags'
import { useTxSelectionStore } from '../../stores/finance/selection'
import type { MandateHistoryItem, Transaction } from '../../api/finance'
import * as api from '../../api/finance'
import { searchDocuments, type DocumentSummary } from '../../api/documents'
import { lookupBtcCodeDe } from '../../utils/btcCodes'

const route = useRoute()
const router = useRouter()
const { goBack } = useModuleBack('/finanzen', 'finance-overview')
const txStore = useTransactionsStore()
const accountsStore = useAccountsStore()
const tagsStore = useTagsStore()
const selectionStore = useTxSelectionStore()
const confirmDialog = useConfirm()

const tx = ref<Transaction | null>(null)
const newTag = ref<string[]>([])
const error = ref<string | null>(null)
const promoting = ref<string | null>(null)
const rejecting = ref<string | null>(null)
const saving = ref(false)
const deleting = ref(false)
const copyToast = ref<string | null>(null)
const linkedDocuments = ref<Array<{ document_id: number; title: string | null; original_filename: string }>>([])
const documentLinkPanelOpen = ref(false)
const documentQuery = ref('')
const documentResults = ref<DocumentSummary[]>([])
const documentSuggestions = ref<api.DocumentMatchSuggestion[]>([])
const documentSearchLoading = ref(false)
const documentSuggestionsLoading = ref(false)
const documentLinkingId = ref<number | null>(null)
const documentDecisionId = ref<number | null>(null)
const expandedSuggestionId = ref<number | null>(null)

async function refreshLinkedDocuments() {
  if (!tx.value) {
    linkedDocuments.value = []
    return
  }
  linkedDocuments.value = await api.getTransactionDocumentLinks(tx.value.id).catch(() => [])
}

async function unlinkDocument(documentId: number) {
  if (!tx.value) return
  try {
    await api.unlinkTransactionDocument(tx.value.id, documentId)
    linkedDocuments.value = linkedDocuments.value.filter(d => d.document_id !== documentId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
function requestUnlinkDocument(documentId: number) {
  confirmDialog.require({
    message: 'Verknüpfung zu diesem Beleg wirklich trennen?',
    header: 'Belegverknüpfung trennen',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Trennen', severity: 'danger' },
    accept: () => { void unlinkDocument(documentId) },
  })
}

async function toggleDocumentLinkPanel() {
  documentLinkPanelOpen.value = !documentLinkPanelOpen.value
  if (documentLinkPanelOpen.value) {
    error.value = null
    await loadDocumentSuggestions()
  }
}

async function searchTransactionDocuments() {
  const query = documentQuery.value.trim()
  if (!query) {
    error.value = 'Bitte einen Suchbegriff für das Dokument eingeben.'
    return
  }
  documentSearchLoading.value = true
  error.value = null
  try {
    documentResults.value = (await searchDocuments(query)).items
  } catch (err) {
    error.value = `Dokumentsuche konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    documentSearchLoading.value = false
  }
}

async function linkDocumentToTransaction(documentId: number) {
  if (!tx.value) return
  documentLinkingId.value = documentId
  error.value = null
  try {
    await api.linkDocumentsToTransactions([tx.value.id], [documentId])
    documentResults.value = documentResults.value.filter(document => document.id !== documentId)
    documentSuggestions.value = documentSuggestions.value.filter(suggestion => suggestion.document_id !== documentId)
    if (documentSuggestions.value.every(suggestion => suggestion.id !== expandedSuggestionId.value)) {
      expandedSuggestionId.value = null
    }
    await refreshLinkedDocuments()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    documentLinkingId.value = null
  }
}

async function loadDocumentSuggestions() {
  if (!tx.value || documentSuggestionsLoading.value) return
  documentSuggestionsLoading.value = true
  error.value = null
  try {
    documentSuggestions.value = await api.suggestDocumentsForTransactions([tx.value.id])
  } catch (err) {
    error.value = `Belegvorschläge konnten nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    documentSuggestionsLoading.value = false
  }
}

async function decideDocumentSuggestion(suggestion: api.DocumentMatchSuggestion, outcome: 'accepted' | 'rejected') {
  if (!tx.value) return
  documentDecisionId.value = suggestion.id
  error.value = null
  try {
    await api.decideDocumentMatch(suggestion.id, outcome)
    documentSuggestions.value = documentSuggestions.value.filter(item => item.id !== suggestion.id)
    if (expandedSuggestionId.value === suggestion.id) expandedSuggestionId.value = null
    if (outcome === 'accepted') await refreshLinkedDocuments()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    documentDecisionId.value = null
  }
}

function suggestionTitle(suggestion: api.DocumentMatchSuggestion): string {
  return suggestion.title ?? suggestion.original_filename
}

function toggleSuggestionPreview(suggestionId: number) {
  expandedSuggestionId.value = expandedSuggestionId.value === suggestionId ? null : suggestionId
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`
}

// Editable form state (kept in sync with tx)
const formNotice = ref('')
const formCounterparty = ref('')
const formPurpose = ref('')
const formAmount = ref('')
const formBookingDate = ref<Date>(new Date())

const numFormAmount = computed({
  get: () => Number(formAmount.value),
  set: (val) => { formAmount.value = String(val) }
})

const account = computed(() => tx.value ? accountsStore.byId(tx.value.account_id) : undefined)
const isCash = computed(() => account.value?.type_kind === 'bargeld')

const inBasket = computed(() => !!tx.value && selectionStore.has(tx.value.id))

function toggleBasket() {
  if (!tx.value) return
  selectionStore.toggle(tx.value)
}

function toIso(d: Date): string {
  return toLocalIsoDate(d)
}

const isDirty = computed(() => {
  if (!tx.value) return false
  if (newTag.value.length > 0) return true
  if (formNotice.value !== (tx.value.notice ?? '')) return true
  if (!isCash.value) return false
  return (
    formCounterparty.value !== (tx.value.counterparty ?? '') ||
    formPurpose.value !== (tx.value.purpose ?? '') ||
    formAmount.value !== tx.value.amount ||
    toIso(formBookingDate.value) !== tx.value.booking_date
  )
})

function syncForm() {
  if (!tx.value) return
  formNotice.value = tx.value.notice ?? ''
  formCounterparty.value = tx.value.counterparty ?? ''
  formPurpose.value = tx.value.purpose ?? ''
  formAmount.value = tx.value.amount
  formBookingDate.value = new Date(tx.value.booking_date)
}

async function loadTransaction(id: number) {
  try {
    error.value = null
    tx.value = await api.getTransaction(id)
    linkedDocuments.value = await api.getTransactionDocumentLinks(id).catch(() => [])
    documentResults.value = []
    documentSuggestions.value = []
    expandedSuggestionId.value = null
    documentLinkPanelOpen.value = false
    documentQuery.value = ''
    syncForm()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    tx.value = null
  }
}

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  if (tagsStore.items.length === 0) await tagsStore.refresh('user')
  await loadTransaction(Number(route.params.id))
})

watch(
  () => route.params.id,
  (id) => {
    if (id == null) return
    void loadTransaction(Number(id))
  },
)

function userTags() {
  return tx.value?.tags.filter((t) => t.source === 'user') ?? []
}
function aiTags() {
  return tx.value?.tags.filter((t) => t.source === 'ai') ?? []
}

async function addUserTags() {
  if (!tx.value || newTag.value.length === 0) return
  try {
    await api.batchTag({
      transaction_ids: [tx.value.id],
      add: newTag.value,
    })
    tagsStore.addLocal(newTag.value)
    tx.value = await api.getTransaction(tx.value.id)
    syncForm()
    newTag.value = []
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function removeUserTag(name: string) {
  if (!tx.value) return
  try {
    await api.batchTag({
      transaction_ids: [tx.value.id],
      remove: [name],
    })
    tx.value = await api.getTransaction(tx.value.id)
    syncForm()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function promote(name: string) {
  if (!tx.value) return
  promoting.value = name
  try {
    const resp = await txStore.promoteAiTag(tx.value.id, name)
    tx.value = { ...tx.value, tags: resp.tags }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    promoting.value = null
  }
}

async function reject(name: string) {
  if (!tx.value) return
  rejecting.value = name
  try {
    const resp = await api.rejectAiTag(tx.value.id, name)
    tx.value = { ...tx.value, tags: resp.tags }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    rejecting.value = null
  }
}

const promotingAll = ref(false)
const rejectingAll = ref(false)

async function promoteAll() {
  if (!tx.value) return
  const tags = aiTags()
  if (tags.length === 0) return
  promotingAll.value = true
  try {
    let updated = tx.value
    for (const t of tags) {
      const resp = await txStore.promoteAiTag(updated.id, t.name)
      updated = { ...updated, tags: resp.tags }
    }
    tx.value = updated
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    promotingAll.value = false
  }
}

async function rejectAll() {
  if (!tx.value) return
  const tags = aiTags()
  if (tags.length === 0) return
  rejectingAll.value = true
  try {
    let updated = tx.value
    for (const t of tags) {
      const resp = await api.rejectAiTag(updated.id, t.name)
      updated = { ...updated, tags: resp.tags }
    }
    tx.value = updated
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    rejectingAll.value = false
  }
}

function cancel() {
  syncForm()
  goBack()
}

async function save() {
  if (!tx.value || !isDirty.value) return
  saving.value = true
  try {
    if (newTag.value.length > 0) {
      await api.batchTag({
        transaction_ids: [tx.value.id],
        add: newTag.value,
      })
      tagsStore.addLocal(newTag.value)
      newTag.value = []
    }
    const input: api.UpdateTransactionInput = {
      notice: formNotice.value || null,
    }
    if (isCash.value) {
      input.counterparty = formCounterparty.value || null
      input.purpose = formPurpose.value || null
      input.amount = formAmount.value
      input.booking_date = toIso(formBookingDate.value)
    }
    tx.value = await api.updateTransaction(tx.value.id, input)
    syncForm()
    goBack()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function deleteTx() {
  if (!tx.value) return
  if (!window.confirm('Diese Buchung wirklich löschen?')) return
  deleting.value = true
  try {
    await api.deleteTransaction(tx.value.id)
    goBack()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    deleting.value = false
  }
}

function formatAmount(): string {
  if (!tx.value || !account.value) return tx.value?.amount ?? ''
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: account.value.currency_code,
  }).format(Number(tx.value.amount))
}

async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value)
    copyToast.value = `${label} kopiert`
    setTimeout(() => { copyToast.value = null }, 2000)
  } catch {
    // ignore
  }
}

// ── Related recurring transactions ──────────────────────────────────────────
// Shows the other bookings of the recurring mandate this transaction
// belongs to. Empty list (and no card) when the transaction is not
// part of any tracked recurring series.
const RECURRING_PREVIEW_COUNT = 3
const recurringItems = ref<MandateHistoryItem[] | null>(null)
const recurringLoading = ref(false)
const recurringError = ref<string | null>(null)
const recurringCounterparty = ref<string | null>(null)
const recurringExpanded = ref(false)

async function loadRecurring(transactionId: number) {
  recurringLoading.value = true
  recurringError.value = null
  recurringExpanded.value = false
  try {
    const res = await api.getRelatedRecurringTransactions(transactionId)
    recurringCounterparty.value = res.counterparty
    recurringItems.value = res.items
  } catch (err) {
    recurringError.value = err instanceof Error ? err.message : String(err)
    recurringItems.value = null
  } finally {
    recurringLoading.value = false
  }
}

const visibleRecurringItems = computed(() => {
  const all = recurringItems.value ?? []
  return recurringExpanded.value
    ? all
    : all.slice(0, RECURRING_PREVIEW_COUNT)
})

const hasMoreRecurring = computed(
  () => (recurringItems.value?.length ?? 0) > RECURRING_PREVIEW_COUNT,
)

watch(
  () => tx.value?.id ?? null,
  (id) => {
    if (id != null) void loadRecurring(id)
    else recurringItems.value = null
  },
)

function openTransaction(id: number) {
  void router.replace({ name: 'finance-transaction-detail', params: { id } })
}

// ── Recurring transaction popup ───────────────────────────────────────────
const recurringPopupVisible = ref(false)
const recurringPopupTx = ref<Transaction | null>(null)
const recurringPopupLoading = ref(false)

async function openRecurringPopup(id: number) {
  recurringPopupLoading.value = true
  recurringPopupVisible.value = true
  recurringPopupTx.value = null
  try {
    recurringPopupTx.value = await api.getTransaction(id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    recurringPopupVisible.value = false
  } finally {
    recurringPopupLoading.value = false
  }
}

function navigateToRecurringTx() {
  if (!recurringPopupTx.value) return
  recurringPopupVisible.value = false
  openTransaction(recurringPopupTx.value.id)
}

const copyingTags = ref(false)

async function copyTagsFromRecurring() {
  if (!tx.value || !recurringPopupTx.value) return
  const sourceTags = recurringPopupTx.value.tags.filter((t) => t.source === 'user')
  if (sourceTags.length === 0) return
  copyingTags.value = true
  try {
    await api.batchTag({
      transaction_ids: [tx.value.id],
      add: sourceTags.map((t) => t.name),
    })
    tagsStore.addLocal(sourceTags.map((t) => t.name))
    tx.value = await api.getTransaction(tx.value.id)
    syncForm()
    recurringPopupVisible.value = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    copyingTags.value = false
  }
}

function formatPopupAmount(t: Transaction): string {
  const currency = account.value?.currency_code ?? 'EUR'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
  }).format(Number(t.amount))
}

function formatRecurringAmount(raw: string): string {
  const currency = account.value?.currency_code ?? 'EUR'
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
  }).format(n)
}

function formatRecurringDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

// Extracted SEPA / bank fields shown when non-null
const extractedFields = computed(() => {
  if (!tx.value) return []
  const t = tx.value
  return [
    { key: 'counterparty_bic', label: 'BIC Gegenseite', value: t.counterparty_bic },
    { key: 'end_to_end_ref', label: 'End-to-End-Referenz', value: t.end_to_end_ref },
    { key: 'mandate_ref', label: 'Mandatsreferenz', value: t.mandate_ref },
    { key: 'creditor_id', label: 'Gläubiger-ID', value: t.creditor_id },
    { key: 'bank_ref', label: 'Bankreferenz', value: t.bank_ref },
    { key: 'originator_name', label: 'Auftraggeber', value: t.originator_name },
    { key: 'recipient_name', label: 'Zahlungsempfänger', value: t.recipient_name },
    { key: 'funds_code', label: 'Domain-Code', value: t.funds_code ? `${t.funds_code} – ${lookupBtcCodeDe('domain', t.funds_code) ?? t.funds_code}` : null },
    { key: 'transaction_type', label: 'GV-Code (Family)', value: t.transaction_type ? `${t.transaction_type} – ${lookupBtcCodeDe('family', t.transaction_type) ?? t.transaction_type}` : null },
    { key: 'transaction_code', label: 'SubFamily-Code', value: t.transaction_code ? `${t.transaction_code} – ${lookupBtcCodeDe('subfamily', t.transaction_code) ?? t.transaction_code}` : null },
    { key: 'entry_text', label: 'Buchungstext', value: t.entry_text },
    { key: 'prima_nota_no', label: 'Primanota', value: t.prima_nota_no },
    { key: 'original_amount', label: 'Originalbetrag', value: t.original_amount ? `${t.original_amount} ${t.original_currency_code ?? ''}`.trim() : null },
    { key: 'exchange_rate', label: 'Wechselkurs', value: t.exchange_rate },
  ].filter((f) => f.value !== null && f.value !== '')
})
</script>

<template>
  <div class="page">
    <header class="page-header">
      <Button
        v-if="isDirty"
        label="Abbrechen"
        severity="secondary"
        text
        @click="cancel"
      />
      <Button
        v-else
        icon="pi pi-chevron-left"
        severity="secondary"
        rounded
        aria-label="Zurück"
        @click="goBack"
      />
      <h1>{{ tx?.counterparty || 'Buchung' }}</h1>
      <Button
        v-if="tx"
        v-tooltip.bottom="inBasket ? 'Aus Basket entfernen' : 'In Basket legen'"
        :icon="inBasket ? 'pi pi-times-circle' : 'pi pi-shopping-cart'"
        :severity="inBasket ? 'success' : 'secondary'"
        :aria-label="inBasket ? 'Aus Basket entfernen' : 'In Basket legen'"
        :aria-pressed="inBasket"
        size="small"
        text
        rounded
        @click="toggleBasket"
      />
      <Button
        v-if="tx"
        label="Speichern"
        icon="pi pi-save"
        size="small"
        :disabled="!isDirty"
        :loading="saving"
        @click="save"
      />
    </header>

    <div v-if="copyToast" class="copy-toast">{{ copyToast }}</div>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">{{ error }}</Message>

    <section v-if="tx" class="card">
      <dl class="details">
        <dt>Verknüpfte Belege</dt>
        <dd class="document-links">
          <div v-if="linkedDocuments.length" class="linked-documents">
            <span v-for="document in linkedDocuments" :key="document.document_id" class="linked-document">
              <Button :label="document.title ?? document.original_filename" size="small" text @click="router.push({ name: 'dokumente-detail', params: { id: document.document_id }, query: { fromTransaction: String(tx.id) } })" />
              <Button icon="pi pi-times" size="small" text aria-label="Belegverknüpfung trennen" @click="requestUnlinkDocument(document.document_id)" />
            </span>
          </div>
          <span v-else class="hint">Keine Belege verknüpft.</span>

          <div class="document-link-actions">
            <Button
              :label="documentLinkPanelOpen ? 'Verknüpfen schließen' : 'Beleg verknüpfen'"
              icon="pi pi-link"
              size="small"
              severity="secondary"
              outlined
              :loading="documentSuggestionsLoading"
              @click="toggleDocumentLinkPanel"
            />
          </div>

          <div v-if="documentLinkPanelOpen" class="document-link-panel">
            <div class="document-panel-section">
              <h3>Dokument suchen</h3>
              <div class="document-search-row">
                <InputText
                  v-model="documentQuery"
                  placeholder="Dokument suchen"
                  @keyup.enter="searchTransactionDocuments"
                />
                <Button
                  label="Suchen"
                  size="small"
                  :loading="documentSearchLoading"
                  @click="searchTransactionDocuments"
                />
              </div>
              <p v-if="!documentSearchLoading && documentResults.length === 0 && documentQuery.trim()" class="hint">
                Keine passenden Dokumente gefunden.
              </p>
              <ul v-if="documentResults.length" class="document-result-list">
                <li v-for="document in documentResults" :key="document.id" class="document-result-row">
                  <span>{{ document.title ?? document.original_filename }}</span>
                  <Button
                    label="Verbinden"
                    size="small"
                    text
                    :loading="documentLinkingId === document.id"
                    @click="linkDocumentToTransaction(document.id)"
                  />
                </li>
              </ul>
            </div>

            <div class="document-panel-section">
              <h3>Mögliche Treffer</h3>
              <p v-if="documentSuggestionsLoading" class="hint">Belegvorschläge werden geladen …</p>
              <p v-else-if="documentSuggestions.length === 0" class="hint">Keine Belegvorschläge gefunden.</p>
              <ul v-else class="document-result-list">
                <li v-for="suggestion in documentSuggestions" :key="suggestion.id" class="document-suggestion">
                  <div class="document-result-row">
                    <button
                      type="button"
                      class="document-suggestion-title"
                      :aria-expanded="expandedSuggestionId === suggestion.id"
                      @click="toggleSuggestionPreview(suggestion.id)"
                    >
                      <span>{{ suggestionTitle(suggestion) }}</span>
                      <small>{{ formatScore(suggestion.score) }}</small>
                    </button>
                    <span class="document-result-actions">
                      <Button
                        label="Vorschau"
                        icon="pi pi-eye"
                        size="small"
                        severity="secondary"
                        text
                        :aria-expanded="expandedSuggestionId === suggestion.id"
                        @click="toggleSuggestionPreview(suggestion.id)"
                      />
                      <Button
                        label="Annehmen"
                        size="small"
                        text
                        :loading="documentDecisionId === suggestion.id"
                        @click="decideDocumentSuggestion(suggestion, 'accepted')"
                      />
                      <Button
                        label="Ablehnen"
                        size="small"
                        severity="secondary"
                        text
                        :disabled="documentDecisionId === suggestion.id"
                        @click="decideDocumentSuggestion(suggestion, 'rejected')"
                      />
                    </span>
                  </div>
                  <div v-if="expandedSuggestionId === suggestion.id" class="document-suggestion-preview">
                    <dl class="document-preview-meta">
                      <template v-if="suggestion.sender">
                        <dt>Absender</dt>
                        <dd>{{ suggestion.sender }}</dd>
                      </template>
                      <template v-if="suggestion.doc_date">
                        <dt>Datum</dt>
                        <dd>{{ suggestion.doc_date }}</dd>
                      </template>
                      <dt>Match</dt>
                      <dd>
                        Gesamt {{ formatScore(suggestion.score) }}
                        · Betrag {{ formatScore(suggestion.amount_score) }}
                        · Datum {{ formatScore(suggestion.date_score) }}
                        · Text {{ formatScore(suggestion.text_score) }}
                      </dd>
                    </dl>
                    <p v-if="suggestion.extracted_text_preview" class="document-preview-text">
                      {{ suggestion.extracted_text_preview }}
                    </p>
                    <p v-else class="hint">Keine Textvorschau verfügbar.</p>
                  </div>
                </li>
              </ul>
            </div>
          </div>

        </dd>
        <dt>Buchungsdatum</dt>
        <dd v-if="isCash">
          <DatePicker v-model="formBookingDate" date-format="dd.mm.yy" show-icon fluid />
        </dd>
        <dd v-else>{{ tx.booking_date }}</dd>

        <template v-if="!isCash">
          <dt>Wertstellung</dt><dd>{{ tx.value_date ?? '—' }}</dd>
        </template>
        <dt>Konto</dt><dd>{{ account?.label }}</dd>
        <dt>Betrag</dt>
        <dd v-if="isCash">
          <InputNumber
            v-model="numFormAmount"
            :minFractionDigits="2"
            :maxFractionDigits="2"
            mode="decimal"
            locale="de-DE"
            fluid
          />
        </dd>
        <dd v-else class="amount" :class="Number(tx.amount) < 0 ? 'amount-neg' : 'amount-pos'">
          {{ formatAmount() }}
        </dd>

        <dt>Gegenseite</dt>
        <dd v-if="isCash">
          <InputText v-model="formCounterparty" class="field-input" />
        </dd>
        <dd v-else>{{ tx.counterparty ?? '—' }}</dd>

        <template v-if="tx.counterparty_iban">
          <dt>IBAN Gegenseite</dt>
          <dd>
            <button class="copy-field" @click="copyToClipboard(tx.counterparty_iban!, 'IBAN')">
              {{ tx.counterparty_iban }}
              <i class="pi pi-copy copy-icon" />
            </button>
          </dd>
        </template>

        <template v-if="!isCash">
          <dt>Verwendung</dt>
          <dd class="multiline">{{ tx.purpose ?? '—' }}</dd>
        </template>
      </dl>
    </section>

    <!-- Tags + Notiz -->
    <section v-if="tx" class="card">
      <h2>Tags</h2>
      <div class="tags-row">
        <Tag
          v-for="t in userTags()"
          :key="t.name"
          severity="info"
          class="tag-chip removable"
        >
          <template #default>
            <span>{{ t.name }}</span>
            <i class="pi pi-times tag-remove" @click="removeUserTag(t.name)" />
          </template>
        </Tag>
        <span v-if="userTags().length === 0" class="hint">Keine Tags.</span>
      </div>
      <div class="field">
        <TagAutoComplete
          v-model="newTag"
          placeholder="Tag hinzufügen…"
        />
        <Button
          class="add-tag-btn"
          label="Tag hinzufügen"
          size="small"
          severity="secondary"
          :disabled="newTag.length === 0"
          @click="addUserTags"
        />
      </div>

      <h2 class="notice-label">Notiz</h2>
      <Textarea
        v-model="formNotice"
        class="notice-input"
        placeholder="Persönliche Notiz …"
        rows="2"
        auto-resize
      />
    </section>

    <!-- KI-Vorschläge -->
    <section v-if="tx && aiTags().length > 0" class="card">
      <div class="ai-header">
        <h2>KI-Vorschläge</h2>
        <div v-if="aiTags().length > 1" class="ai-bulk-actions">
          <Button
            label="Alle übernehmen"
            icon="pi pi-check-circle"
            size="small"
            :loading="promotingAll"
            :disabled="rejectingAll"
            @click="promoteAll"
          />
          <Button
            label="Alle ablehnen"
            icon="pi pi-times-circle"
            severity="secondary"
            size="small"
            :loading="rejectingAll"
            :disabled="promotingAll"
            @click="rejectAll"
          />
        </div>
      </div>
      <ul class="ai-list">
        <li v-for="t in aiTags()" :key="t.name" class="ai-item">
          <span class="ai-label">
            <span class="name">{{ t.name }}</span>
            <span class="confidence">{{ t.confidence !== null ? (t.confidence * 100).toFixed(0) + '%' : '—' }}</span>
          </span>
          <span class="ai-actions">
            <Button
              label="Übernehmen"
              icon="pi pi-check"
              size="small"
              :loading="promoting === t.name"
              :disabled="rejecting === t.name || promotingAll || rejectingAll"
              @click="promote(t.name)"
            />
            <Button
              label="Ablehnen"
              icon="pi pi-times"
              severity="secondary"
              size="small"
              :loading="rejecting === t.name"
              :disabled="promoting === t.name || promotingAll || rejectingAll"
              @click="reject(t.name)"
            />
          </span>
        </li>
      </ul>
    </section>

    <!-- Extracted SEPA fields -->
    <section v-if="tx && extractedFields.length > 0" class="card">
      <h2>Weitere Informationen</h2>
      <dl class="details">
        <template v-for="f in extractedFields" :key="f.key">
          <dt>{{ f.label }}</dt>
          <dd>
            <button class="copy-field" @click="copyToClipboard(f.value!, f.label)">
              {{ f.value }}
              <i class="pi pi-copy copy-icon" />
            </button>
          </dd>
        </template>
      </dl>
    </section>

    <!-- Related recurring transactions -->
    <section
      v-if="tx && (recurringLoading || (recurringItems && recurringItems.length > 0) || recurringError)"
      class="card"
    >
      <h2>
        Wiederkehrende Buchungen
        <span v-if="recurringCounterparty" class="recurring-subtitle">
          · {{ recurringCounterparty }}
        </span>
      </h2>
      <Message
        v-if="recurringError"
        severity="error"
        :closable="true"
        @close="recurringError = null"
      >
        {{ recurringError }}
      </Message>
      <div v-if="recurringLoading && !recurringItems" class="hint">Lädt …</div>
      <ul v-else-if="(recurringItems?.length ?? 0) > 0" class="recurring-list">
        <li
          v-for="it in visibleRecurringItems"
          :key="it.id"
          class="recurring-row"
          @click="openRecurringPopup(it.id)"
        >
          <span class="recurring-date">{{ formatRecurringDate(it.booking_date) }}</span>
          <span class="recurring-amount">{{ formatRecurringAmount(it.amount) }}</span>
          <span class="recurring-purpose">{{ it.purpose ?? '' }}</span>
        </li>
      </ul>
      <button
        v-if="hasMoreRecurring"
        class="recurring-toggle"
        @click="recurringExpanded = !recurringExpanded"
      >
        <i :class="recurringExpanded ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" />
        {{
          recurringExpanded
            ? 'Weniger anzeigen'
            : `${(recurringItems?.length ?? 0) - RECURRING_PREVIEW_COUNT} weitere anzeigen`
        }}
      </button>
    </section>

    <!-- Actions -->
    <div v-if="tx && isCash" class="page-actions">
      <Button
        label="Löschen"
        icon="pi pi-trash"
        severity="danger"
        :loading="deleting"
        @click="deleteTx"
      />
    </div>

    <!-- Recurring transaction popup -->
    <Dialog
      v-model:visible="recurringPopupVisible"
      modal
      header="Wiederkehrende Buchung"
      :style="{ width: '30rem' }"
    >
      <div v-if="recurringPopupLoading" class="hint">Lädt …</div>
      <template v-if="recurringPopupTx">
        <dl class="details">
        <dt>Buchungsdatum</dt>
          <dd>{{ recurringPopupTx.booking_date }}</dd>
          <template v-if="recurringPopupTx.value_date">
            <dt>Wertstellung</dt>
            <dd>{{ recurringPopupTx.value_date }}</dd>
          </template>
          <dt>Betrag</dt>
          <dd :class="['amount', Number(recurringPopupTx.amount) < 0 ? 'amount-neg' : 'amount-pos']">
            {{ formatPopupAmount(recurringPopupTx) }}
          </dd>
          <dt>Gegenseite</dt>
          <dd>{{ recurringPopupTx.counterparty ?? '—' }}</dd>
          <template v-if="recurringPopupTx.counterparty_iban">
            <dt>IBAN</dt>
            <dd>{{ recurringPopupTx.counterparty_iban }}</dd>
          </template>
          <dt>Verwendung</dt>
          <dd class="multiline">{{ recurringPopupTx.purpose ?? '—' }}</dd>
          <dt>Tags</dt>
          <dd>
            <div class="tags-row">
              <Tag
                v-for="t in recurringPopupTx.tags.filter(t => t.source === 'user')"
                :key="t.name"
                severity="info"
              >
                {{ t.name }}
              </Tag>
              <span v-if="recurringPopupTx.tags.filter(t => t.source === 'user').length === 0" class="hint">Keine Tags.</span>
            </div>
          </dd>
        </dl>
      </template>
      <template #footer>
        <Button
          v-if="recurringPopupTx && recurringPopupTx.tags.filter(t => t.source === 'user').length > 0"
          label="Tags übernehmen"
          icon="pi pi-copy"
          size="small"
          :loading="copyingTags"
          @click="copyTagsFromRecurring"
        />
        <Button
          label="Transaktion öffnen"
          severity="secondary"
          size="small"
          @click="navigateToRecurringTx"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 48rem;
}
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
}
.page-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  position: sticky;
  top: var(--menubar-height, 3.5rem);
  z-index: 100;
  background: var(--p-content-hover-background);
  margin: -1.5rem -1.5rem 0;
  padding: 0.75rem 1.5rem;
}
@media (max-width: 640px) {
  .page-header {
    margin: -0.75rem -0.75rem 0;
    padding: 0.5rem 0.75rem;
  }
}
.page-header h1 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.card h2 {
  margin: 0.25rem 0 0.25rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.details {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0.5rem 1rem;
  margin: 0;
}
.details dt {
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  align-self: center;
}
.details dd {
  margin: 0;
  min-width: 0;
  word-break: break-word;
}
.document-links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.linked-documents {
  display: flex;
  flex-wrap: wrap;
  gap: .25rem .5rem;
}
.linked-document {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--p-content-border-color);
  border-radius: .35rem;
}
.linked-document :deep(.p-button) {
  padding-block: .25rem;
}
.document-link-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.document-link-panel {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
  padding: 0.75rem;
  background: var(--p-content-hover-background);
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.document-panel-section {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.document-panel-section h3 {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  font-weight: 600;
}
.document-search-row {
  display: flex;
  gap: 0.5rem;
}
.document-search-row :deep(.p-inputtext) {
  flex: 1;
  min-width: 0;
}
.document-result-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0;
  margin: 0.5rem 0 0;
}
.document-result-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.25rem 0;
}
.document-result-row > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.document-suggestion {
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.35rem;
}
.document-suggestion:first-child {
  border-top: none;
  padding-top: 0;
}
.document-suggestion-title {
  display: inline-flex;
  align-items: baseline;
  flex: 1;
  gap: 0.5rem;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-align: left;
}
.document-suggestion-title:hover span {
  text-decoration: underline;
}
.document-suggestion-title span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.document-suggestion-title small {
  color: var(--p-text-muted-color);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.document-suggestion-preview {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin-top: 0.45rem;
  border-radius: 0.45rem;
  background: var(--p-content-background);
  padding: 0.65rem 0.75rem;
}
.document-preview-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.6rem;
  margin: 0;
  font-size: 0.85rem;
}
.document-preview-meta dt {
  color: var(--p-text-muted-color);
}
.document-preview-meta dd {
  margin: 0;
}
.document-preview-text {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  line-height: 1.35;
}
.document-result-actions {
  display: inline-flex;
  flex-wrap: wrap;
  flex-shrink: 0;
  justify-content: flex-end;
  gap: 0.25rem;
}
@media (max-width: 520px) {
  .details {
    grid-template-columns: 1fr;
  }
  .details dt {
    align-self: auto;
  }
  .document-search-row,
  .document-result-row {
    align-items: stretch;
    flex-direction: column;
  }
  .document-result-actions {
    justify-content: flex-end;
  }
  .document-result-actions :deep(.p-button-label) {
    display: none;
  }
}
.field-input {
  width: 100%;
}
.amount {
  font-weight: 600;
}
.amount-pos { color: var(--p-text-color); }
.amount-neg { color: var(--p-red-600, #c0392b); }
.multiline {
  font-family: monospace;
  white-space: pre-wrap;
}
.copy-field {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--p-text-color);
  font-size: inherit;
  font-family: inherit;
  text-align: left;
  word-break: break-all;
}
.copy-field:hover { text-decoration: underline; }
.copy-icon {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  flex-shrink: 0;
}
.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  min-height: 1.5rem;
}
.tag-chip.removable :deep(.p-tag-value) {
  display: inline-flex;
  gap: 0.375rem;
  align-items: center;
}
.tag-remove {
  cursor: pointer;
  font-size: 0.75rem;
}
.field {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
}
.field :deep(.p-autocomplete) {
  flex: 1;
}
.add-tag-btn {
  flex-shrink: 0;
  align-self: flex-start;
  margin-top: 0.1rem;
}
.notice-label {
  margin-top: 0.5rem !important;
}
.notice-input {
  width: 100%;
}
.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.ai-header h2 {
  margin: 0.25rem 0 0.25rem;
}
.ai-bulk-actions {
  display: flex;
  gap: 0.5rem;
}
.ai-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.ai-item {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.ai-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
}
.ai-label .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-label .confidence {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.ai-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}
@media (max-width: 480px) {
  .ai-actions :deep(.p-button-label),
  .ai-bulk-actions :deep(.p-button-label) {
    display: none;
  }
  .ai-actions :deep(.p-button),
  .ai-bulk-actions :deep(.p-button) {
    padding: 0.4rem;
  }
}
.hint {
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}
.page-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  padding: 0.5rem 0;
}
.recurring-subtitle {
  color: var(--p-text-muted-color);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}
.recurring-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.recurring-row {
  display: grid;
  grid-template-columns: 6.5rem 6.5rem 1fr;
  gap: 0.5rem;
  padding: 0.4rem 0.25rem;
  border-radius: 0.25rem;
  cursor: pointer;
  align-items: baseline;
  font-size: 0.9rem;
}
.recurring-row:hover {
  background: var(--p-content-hover-background);
}
.recurring-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.recurring-amount {
  font-family: monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.recurring-purpose {
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 540px) {
  .recurring-row {
    grid-template-columns: 5.5rem 6rem;
    grid-template-rows: auto auto;
  }
  .recurring-purpose {
    grid-column: 1 / -1;
    white-space: normal;
  }
}
.recurring-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: none;
  border: none;
  padding: 0.3rem 0;
  cursor: pointer;
  color: var(--p-primary-color, var(--p-text-color));
  font-size: 0.875rem;
  font-family: inherit;
  margin-top: 0.25rem;
}
.recurring-toggle:hover {
  text-decoration: underline;
}
.copy-toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: var(--p-primary-700, #1f6e3a);
  color: #fff;
  padding: 0.5rem 1.25rem;
  border-radius: 2rem;
  font-size: 0.9rem;
  z-index: 9999;
  pointer-events: none;
}
</style>
