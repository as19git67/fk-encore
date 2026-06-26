<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import DatePicker from 'primevue/datepicker'
import Button from 'primevue/button'
import AutoComplete from 'primevue/autocomplete'
import TagAutoComplete from '../../components/finance/TagAutoComplete.vue'
import Message from 'primevue/message'
import { toLocalIsoDate } from '../../utils/dateFormat'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useTagsStore } from '../../stores/finance/tags'
import { linkDocumentsToTransactions, recentCashRecipients, searchRecipients, type RecentRecipient } from '../../api/finance'
import { searchDocuments, uploadReceiptCapture, type DocumentSummary } from '../../api/documents'
import { recognizeReceipt } from '../../utils/receiptOcr'
import { parseLocalDate } from '../../utils/dateFormat'
import { useModuleBack } from '../../composables/useModuleBack'
import { queuePendingTransaction } from '../../utils/offlineQueue'
import { useOfflineSync } from '../../composables/useOfflineSync'

const route = useRoute()
const router = useRouter()
const { goBack } = useModuleBack('/finanzen', 'finance-overview')
const accountsStore = useAccountsStore()
const txStore = useTransactionsStore()
const tagsStore = useTagsStore()

const accountId = ref<number | null>(null)
const bookingDate = ref<Date>(new Date())
const amount = ref<number | null>(null)
const isExpense = ref(true)
const counterparty = ref('')
const purpose = ref('') // mapped to purpose in backend if needed, or just notes
const tags = ref<string[]>([])
const error = ref<string | null>(null)
const saving = ref(false)

const amountInput = ref<any>(null)

const recentRecipients = ref<RecentRecipient[]>([])
const recipientSuggestions = ref<RecentRecipient[]>([])
const documentQuery = ref('')
const documentResults = ref<DocumentSummary[]>([])
const selectedDocuments = ref<DocumentSummary[]>([])
const searchingDocuments = ref(false)
const documentSearchError = ref<string | null>(null)
const receiptInput = ref<HTMLInputElement | null>(null)
const receiptUploading = ref(false)
const receiptStatus = ref<string | null>(null)
const receiptSuggestion = ref<string | null>(null)
const receiptDocumentId = ref<number | null>(null)
const receiptProcessedBlob = ref<Blob | null>(null)
const dateTouched = ref(false)
const isOnline = ref(navigator.onLine)

const { pendingCount, draining, lastResult } = useOfflineSync()

const cashAccounts = computed(() =>
  accountsStore.items.filter(
    (a) => a.type_kind === 'bargeld' && !a.closed_at,
  ),
)

function onOnlineChange() { isOnline.value = navigator.onLine }

onMounted(async () => {
  window.addEventListener('online', onOnlineChange)
  window.addEventListener('offline', onOnlineChange)

  if (accountsStore.items.length === 0) await accountsStore.refresh()
  if (tagsStore.items.length === 0) await tagsStore.refresh('user')

  const queryAccountId = Number(route.query.accountId)
  if (queryAccountId) {
    accountId.value = queryAccountId
  } else if (cashAccounts.value.length === 1) {
    accountId.value = cashAccounts.value[0]!.id
  }

  try {
    const resp = await recentCashRecipients()
    recentRecipients.value = resp.items
  } catch {
    // best-effort
  }

  // Focus amount field
  setTimeout(() => {
    if (amountInput.value) {
      const input = amountInput.value.$el.querySelector('input')
      if (input) input.focus()
    }
  }, 100)
})

function applyRecipient(r: RecentRecipient) {
  counterparty.value = r.counterparty
  tags.value = [...(r.tags || [])]
}

async function findRecipients(event: { query: string }) {
  const q = event.query.trim()
  if (q.length === 0) {
    recipientSuggestions.value = []
    return
  }
  try {
    const resp = await searchRecipients(q)
    const items = resp.items
    const exactMatch = items.some((i) => i.counterparty.toLowerCase() === q.toLowerCase())
    if (!exactMatch && q.length > 0) {
      recipientSuggestions.value = [
        { counterparty: q, tags: [], isNew: true } as any,
        ...items,
      ]
    } else {
      recipientSuggestions.value = items
    }
  } catch {
    recipientSuggestions.value = []
  }
}

function onRecipientSelect(event: { value: string | RecentRecipient }) {
  if (typeof event.value === 'string') {
    counterparty.value = event.value
  } else {
    counterparty.value = event.value.counterparty
    if (event.value.tags && event.value.tags.length > 0) {
      tags.value = [...event.value.tags]
    }
  }
}

function setDate(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  bookingDate.value = d
  dateTouched.value = true
}

function toIso(d: Date): string {
  return toLocalIsoDate(d)
}

function documentLabel(document: DocumentSummary): string {
  return document.title?.trim() || document.original_filename
}

function formatDocumentMeta(document: DocumentSummary): string {
  const parts = [document.sender, document.doc_date]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
  return parts.join(' · ')
}

async function findDocuments() {
  const query = documentQuery.value.trim()
  documentSearchError.value = null
  if (!query) {
    documentSearchError.value = 'Bitte einen Suchbegriff für das Dokument eingeben.'
    return
  }
  searchingDocuments.value = true
  try {
    const selectedIds = new Set(selectedDocuments.value.map(document => document.id))
    documentResults.value = (await searchDocuments(query)).items
      .filter(document => !selectedIds.has(document.id))
  } catch (err) {
    documentSearchError.value = err instanceof Error ? err.message : String(err)
  } finally {
    searchingDocuments.value = false
  }
}

function selectDocument(document: DocumentSummary) {
  if (selectedDocuments.value.some(item => item.id === document.id)) return
  selectedDocuments.value = [...selectedDocuments.value, document]
  documentResults.value = documentResults.value.filter(item => item.id !== document.id)
}

function removeSelectedDocument(documentId: number) {
  selectedDocuments.value = selectedDocuments.value.filter(document => document.id !== documentId)
}

function openReceiptCapture() {
  if (receiptUploading.value) return
  receiptInput.value?.click()
}

async function onReceiptPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  documentSearchError.value = null
  receiptSuggestion.value = null
  receiptUploading.value = true
  receiptStatus.value = 'Beleg wird erkannt …'
  try {
    const result = await recognizeReceipt(file)
    const applied = applyOcrResult(result)
    receiptProcessedBlob.value = result.processedImage

    if (isOnline.value) {
      receiptStatus.value = 'Beleg wird hochgeladen …'
      const processedFile = new File([result.processedImage], file.name || 'receipt.jpg', {
        type: result.processedImage.type,
      })
      const uploaded = await uploadReceiptCapture(processedFile)
      receiptDocumentId.value = uploaded.id
      selectDocument(uploaded)
    }

    receiptStatus.value = null
    if (!isOnline.value) {
      receiptSuggestion.value = applied.length > 0
        ? `Aus Beleg übernommen: ${applied.join(', ')}. Beleg wird hochgeladen, sobald du online bist.`
        : 'Beleg wird hochgeladen, sobald du online bist.'
    } else {
      receiptSuggestion.value = applied.length > 0
        ? `Aus Beleg übernommen: ${applied.join(', ')}. Empfänger und Kategorie werden im Hintergrund ergänzt.`
        : 'Beleg wurde erkannt, aber es gab keine neuen Formularwerte. Server-Analyse läuft im Hintergrund.'
    }
  } catch (err) {
    receiptStatus.value = null
    documentSearchError.value = err instanceof Error ? err.message : String(err)
  } finally {
    receiptUploading.value = false
  }
}

function applyOcrResult(result: { amount: number | null; date: string | null }): string[] {
  const applied: string[] = []
  if (result.amount != null && (!amount.value || amount.value <= 0)) {
    amount.value = result.amount
    isExpense.value = true
    applied.push('Betrag')
  }
  if (result.date && !dateTouched.value) {
    const parsed = parseLocalDate(result.date)
    if (!Number.isNaN(parsed.getTime())) {
      bookingDate.value = parsed
      applied.push('Datum')
    }
  }
  return applied
}

async function save() {
  error.value = null
  if (!accountId.value) {
    error.value = 'Bitte ein Konto auswählen.'
    return
  }
  if (!amount.value || amount.value <= 0) {
    error.value = 'Bitte einen Betrag eingeben.'
    return
  }

  const counterpartyName = (typeof counterparty.value === 'string'
    ? counterparty.value
    : (counterparty.value as any).counterparty || '').trim()

  if (!counterpartyName) {
    error.value = 'Empfänger ist ein Pflichtfeld.'
    return
  }
  const signedAmount = isExpense.value ? -Math.abs(amount.value) : Math.abs(amount.value)

  if (!isOnline.value) {
    return saveOffline(signedAmount, counterpartyName)
  }

  saving.value = true
  try {
    const created = await txStore.create({
      account_id: accountId.value,
      booking_date: toIso(bookingDate.value),
      amount: signedAmount,
      counterparty: counterpartyName,
      purpose: purpose.value.trim() || undefined,
      tags: tags.value,
      receipt_document_id: receiptDocumentId.value ?? undefined,
    })
    const manualDocIds = selectedDocuments.value
      .filter(document => document.id !== receiptDocumentId.value)
      .map(document => document.id)
    if (manualDocIds.length > 0) {
      try {
        await linkDocumentsToTransactions([created.id], manualDocIds)
      } catch (err) {
        error.value = `Buchung wurde erstellt, aber die Dokumente konnten nicht verknüpft werden: ${err instanceof Error ? err.message : String(err)}`
        return
      }
    }
    tagsStore.addLocal(tags.value)
    void router.push({ name: 'finance-account-transactions', params: { id: accountId.value } })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function saveOffline(signedAmount: number, counterpartyName: string) {
  saving.value = true
  try {
    const entry: Parameters<typeof queuePendingTransaction>[0] = {
      accountId: accountId.value!,
      bookingDate: toIso(bookingDate.value),
      amount: signedAmount,
      counterparty: counterpartyName,
      purpose: purpose.value.trim() || undefined,
      tags: [...tags.value],
    }
    if (receiptProcessedBlob.value) {
      entry.receiptBlob = await receiptProcessedBlob.value.arrayBuffer()
      entry.receiptFileName = 'receipt.jpg'
      entry.receiptMimeType = receiptProcessedBlob.value.type || 'image/jpeg'
    }
    await queuePendingTransaction(entry)
    tagsStore.addLocal(tags.value)
    void router.push({ name: 'finance-account-transactions', params: { id: accountId.value } })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <div v-if="cashAccounts.length > 0" class="account-name-top">
      Konto: <strong>{{ accountsStore.byId(accountId ?? -1)?.label ?? '…' }}</strong>
    </div>
    <Message v-else severity="warn" :closable="false">
      Kein Bargeldkonto (Typ „bargeld") vorhanden. Bitte zuerst ein Konto anlegen.
    </Message>

    <Message v-if="!isOnline" severity="warn" :closable="false">
      <i class="pi pi-wifi-off" /> Offline — Buchung wird lokal gespeichert und bei Verbindung gesendet.
    </Message>
    <Message v-if="pendingCount > 0 && isOnline" severity="info" :closable="false">
      <template v-if="draining">
        <i class="pi pi-spin pi-spinner" /> {{ pendingCount }} offline gespeicherte Buchung(en) werden gesendet …
      </template>
      <template v-else-if="lastResult?.failed">
        {{ lastResult.success }} gesendet, {{ lastResult.failed }} fehlgeschlagen — wird beim nächsten Mal erneut versucht.
      </template>
      <template v-else>
        {{ lastResult?.success ?? pendingCount }} offline gespeicherte Buchung(en) erfolgreich gesendet.
      </template>
    </Message>
    <Message v-if="error" severity="error" :closable="true" @close="error = null">
      {{ error }}
    </Message>

    <!-- Betrag + Vorzeichen -->
    <div class="field">
      <label class="field-label">Betrag <span class="req">*</span></label>
      <div class="amount-block">
        <Button
          class="sign-btn"
          :label="isExpense ? '− Ausgabe' : '+ Einnahme'"
          :severity="isExpense ? 'danger' : 'success'"
          @click="isExpense = !isExpense"
        />
        <InputNumber
          ref="amountInput"
          v-model="amount"
          :min="0"
          :minFractionDigits="2"
          :maxFractionDigits="2"
          mode="decimal"
          placeholder="0,00"
          class="amount-input"
          input-class="amount-number"
          autofocus
        />
      </div>
    </div>

    <div class="field">
      <label class="field-label">Buchungsdatum <span class="req">*</span></label>
      <div class="date-row">
        <DatePicker
          v-model="bookingDate"
          date-format="dd.mm.yy"
          show-icon
          fluid
          @update:model-value="dateTouched = true"
        />
        <div class="date-presets">
          <Button label="Heute" size="small" severity="primary" outlined @click="setDate(0)" />
          <Button label="Gestern" size="small" severity="primary" outlined @click="setDate(-1)" />
        </div>
      </div>
    </div>

    <!-- Empfänger -->
    <div class="field">
      <label class="field-label">Empfänger <span class="req">*</span></label>
      <AutoComplete
        v-model="counterparty"
        :suggestions="recipientSuggestions"
        optionLabel="counterparty"
        placeholder="Name eingeben …"
        fluid
        class="recipient-input"
        @complete="findRecipients"
        @item-select="onRecipientSelect"
      >
        <template #option="{ option }">
          <span v-if="(option as any).isNew" class="recipient-new">+ Neu: </span>
          <span>{{ option.counterparty }}</span>
        </template>
      </AutoComplete>
    </div>

    <!-- Tags -->
    <div class="field">
      <label class="field-label">Tags</label>
      <TagAutoComplete
        v-model="tags"
        placeholder="Tags …"
      />
    </div>

    <!-- Notiz -->
    <div class="field">
      <label class="field-label">Notiz</label>
      <InputText
        v-model="purpose"
        type="text"
        class="recipient-input"
        placeholder="Notiz zur Buchung …"
      />
    </div>

    <!-- Dokumente -->
    <section class="document-link-section" aria-labelledby="cash-document-links-title">
      <div class="section-head">
        <div>
          <h2 id="cash-document-links-title" class="section-title">Dokumente verknüpfen</h2>
          <p class="section-hint">Optional: Belege suchen und direkt mit dieser Bargeldbuchung speichern.</p>
        </div>
        <span v-if="selectedDocuments.length" class="document-count">
          {{ selectedDocuments.length }}
        </span>
      </div>

      <div class="document-search-row">
        <InputText
          v-model="documentQuery"
          class="document-search-input"
          placeholder="Dokument suchen …"
          @keyup.enter="findDocuments"
        />
        <input
          ref="receiptInput"
          type="file"
          accept="image/*"
          capture="environment"
          class="receipt-input"
          @change="onReceiptPicked"
        >
        <Button
          icon="pi pi-camera"
          severity="secondary"
          outlined
          aria-label="Beleg fotografieren"
          :loading="receiptUploading"
          @click="openReceiptCapture"
        />
        <Button
          icon="pi pi-search"
          aria-label="Dokument suchen"
          :loading="searchingDocuments"
          @click="findDocuments"
        />
      </div>
      <p v-if="receiptStatus" class="document-info">{{ receiptStatus }}</p>
      <p v-if="receiptSuggestion" class="document-success">{{ receiptSuggestion }}</p>
      <p v-if="documentSearchError" class="document-error">{{ documentSearchError }}</p>

      <ul v-if="selectedDocuments.length" class="document-list selected-documents" aria-label="Ausgewählte Dokumente">
        <li v-for="document in selectedDocuments" :key="document.id" class="document-row">
          <div class="document-row-text">
            <strong>{{ documentLabel(document) }}</strong>
            <small v-if="formatDocumentMeta(document)">{{ formatDocumentMeta(document) }}</small>
          </div>
          <Button
            icon="pi pi-times"
            size="small"
            text
            rounded
            severity="secondary"
            :aria-label="`${documentLabel(document)} entfernen`"
            @click="removeSelectedDocument(document.id)"
          />
        </li>
      </ul>

      <ul v-if="documentResults.length" class="document-list search-results" aria-label="Gefundene Dokumente">
        <li v-for="document in documentResults" :key="document.id" class="document-row">
          <div class="document-row-text">
            <strong>{{ documentLabel(document) }}</strong>
            <small v-if="formatDocumentMeta(document)">{{ formatDocumentMeta(document) }}</small>
          </div>
          <Button
            class="document-select-button"
            label="Auswählen"
            icon="pi pi-plus"
            size="small"
            outlined
            @click="selectDocument(document)"
          />
        </li>
      </ul>
    </section>

    <!-- Aktionen -->
    <div class="actions-row">
      <Button
        class="save-btn"
        :label="receiptUploading ? 'Beleg wird verarbeitet …' : isOnline ? 'Speichern' : 'Offline speichern'"
        icon="pi pi-check"
        :loading="saving"
        :disabled="!amount || !counterparty.trim() || !accountId || receiptUploading"
        @click="save"
      />
      <Button
        label="Abbrechen"
        severity="secondary"
        outlined
        class="cancel-btn"
        @click="goBack"
      />
    </div>

    <!-- Letzte Empfänger als Badges -->
    <div v-if="recentRecipients.length > 0" class="recent-section">
      <p class="recent-label">Zuletzt verwendet</p>
      <div class="recent-list">
        <button
          v-for="r in recentRecipients"
          :key="r.counterparty"
          class="recent-badge"
          @click="applyRecipient(r)"
        >
          {{ r.counterparty }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
  max-width: 38rem;
}
@media (max-width: 480px) {
  .page {
    padding: 0.75rem;
  }
}
.account-select {
  width: 100%;
}
.account-name-top {
  font-size: 1.1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
  margin-bottom: 0.5rem;
}
.amount-block {
  display: flex;
  align-items: stretch;
  gap: 0.75rem;
}
.sign-btn {
  flex-shrink: 0;
  min-width: 8rem;
  font-weight: 600;
}
.amount-input {
  flex: 1;
}
.amount-input :deep(.amount-number) {
  font-size: 1.6rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  width: 100%;
  text-align: right;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field-label {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
}
.req {
  color: var(--p-red-500);
}
.recipient-input {
  width: 100%;
  font-size: 1rem;
}
.recipient-new {
  font-style: italic;
  color: var(--p-primary-color);
  font-weight: 600;
}
.save-btn {
  flex: 2 2 auto;
  padding: 0.85rem;
  font-size: 1rem;
  font-weight: 600;
  margin-top: 0.25rem;
}
.cancel-btn {
  flex: 1 1 auto;
  padding: 0.85rem;
  font-size: 1rem;
  font-weight: 600;
  margin-top: 0.25rem;
}
.recent-section {
  margin-top: 0.5rem;
}
.recent-label {
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  margin: 0 0 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.recent-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.date-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.date-presets {
  display: flex;
  gap: 0.4rem;
}
.actions-row {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}
.document-link-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.85rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.85rem;
  background: var(--p-content-background);
}
.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.section-title {
  margin: 0;
  font-size: 1rem;
}
.section-hint {
  margin: 0.2rem 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  line-height: 1.35;
}
.document-count {
  min-width: 1.7rem;
  height: 1.7rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
  font-weight: 700;
}
.document-search-row {
  display: flex;
  gap: 0.5rem;
}
.document-search-input {
  flex: 1;
  min-width: 0;
}
.receipt-input {
  display: none;
}
.document-info,
.document-success,
.document-error {
  margin: 0;
  font-size: 0.85rem;
}
.document-info {
  color: var(--p-text-muted-color);
}
.document-success {
  color: var(--p-green-600);
}
.document-error {
  color: var(--p-red-500);
}
.document-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.document-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.7rem;
  background: var(--p-content-hover-background);
}
.document-row-text {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.document-row-text strong,
.document-row-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-row-text small {
  color: var(--p-text-muted-color);
}
.selected-documents .document-row {
  border-color: color-mix(in srgb, var(--p-primary-color) 38%, var(--p-content-border-color));
  background: color-mix(in srgb, var(--p-primary-color) 8%, var(--p-content-background));
}
.document-select-button {
  flex: 0 0 auto;
  white-space: nowrap;
}
@media (max-width: 420px) {
  .document-row {
    gap: 0.5rem;
    padding-inline: 0.6rem;
  }
  .document-select-button {
    width: 2.5rem;
    min-width: 2.5rem;
    padding-inline: 0;
  }
  .document-select-button :deep(.p-button-label) {
    display: none;
  }
}
.recent-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.35rem 0.85rem;
  border-radius: 999px;
  background: var(--p-highlight-background);
  border: 1px solid var(--p-content-border-color);
  cursor: pointer;
  font-size: 0.85rem;
  font-family: inherit;
  color: var(--p-highlight-color);
  transition: all 0.1s;
}
.recent-badge:hover {
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent);
  border-color: var(--p-primary-color);
}
.recent-tags {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
</style>
