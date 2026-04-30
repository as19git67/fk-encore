<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import InputText from 'primevue/inputtext'
import TagAutoComplete from '../../components/finance/TagAutoComplete.vue'
import Textarea from 'primevue/textarea'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTagsStore } from '../../stores/finance/tags'
import type { Transaction } from '../../api/finance'
import * as api from '../../api/finance'

const route = useRoute()
const router = useRouter()
const txStore = useTransactionsStore()
const accountsStore = useAccountsStore()
const tagsStore = useTagsStore()

const tx = ref<Transaction | null>(null)
const newTag = ref<string[]>([])
const error = ref<string | null>(null)
const promoting = ref<string | null>(null)
const saving = ref(false)
const deleting = ref(false)
const copyToast = ref<string | null>(null)

// Editable form state (kept in sync with tx)
const formNotice = ref('')
const formCounterparty = ref('')
const formPurpose = ref('')
const formAmount = ref('')
const formBookingDate = ref('')

const account = computed(() => tx.value ? accountsStore.byId(tx.value.account_id) : undefined)
const isCash = computed(() => account.value?.type_kind === 'bargeld')

const isDirty = computed(() => {
  if (!tx.value) return false
  if (formNotice.value !== (tx.value.notice ?? '')) return true
  if (!isCash.value) return false
  return (
    formCounterparty.value !== (tx.value.counterparty ?? '') ||
    formPurpose.value !== (tx.value.purpose ?? '') ||
    formAmount.value !== tx.value.amount ||
    formBookingDate.value !== tx.value.booking_date
  )
})

function syncForm() {
  if (!tx.value) return
  formNotice.value = tx.value.notice ?? ''
  formCounterparty.value = tx.value.counterparty ?? ''
  formPurpose.value = tx.value.purpose ?? ''
  formAmount.value = tx.value.amount
  formBookingDate.value = tx.value.booking_date
}

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  if (tagsStore.items.length === 0) await tagsStore.refresh('user')
  try {
    const id = Number(route.params.id)
    tx.value = await api.getTransaction(id)
    syncForm()
    if (!tx.value.seen) {
      void api.markTransactionSeen(id)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

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

async function save() {
  if (!tx.value || !isDirty.value) return
  saving.value = true
  try {
    const input: api.UpdateTransactionInput = {
      notice: formNotice.value || null,
    }
    if (isCash.value) {
      input.counterparty = formCounterparty.value || null
      input.purpose = formPurpose.value || null
      input.amount = formAmount.value
      input.booking_date = formBookingDate.value
    }
    tx.value = await api.updateTransaction(tx.value.id, input)
    syncForm()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function deleteTx() {
  if (!tx.value) return
  if (!confirm('Diese Buchung wirklich löschen?')) return
  deleting.value = true
  try {
    await api.deleteTransaction(tx.value.id)
    router.back()
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
    { key: 'gv_code', label: 'GV-Code', value: t.gv_code },
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
      <Button icon="pi pi-chevron-left" severity="secondary" rounded aria-label="Zurück" @click="router.back()" />
      <h1>{{ tx?.counterparty || 'Buchung' }}</h1>
    </header>

    <div v-if="copyToast" class="copy-toast">{{ copyToast }}</div>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">{{ error }}</Message>

    <section v-if="tx" class="card">
      <dl class="details">
        <dt>Buchungsdatum</dt>
        <dd v-if="isCash">
          <InputText v-model="formBookingDate" class="field-input" />
        </dd>
        <dd v-else>{{ tx.booking_date }}</dd>

        <dt>Wertstellung</dt><dd>{{ tx.value_date ?? '—' }}</dd>
        <dt>Konto</dt><dd>{{ account?.label }}</dd>
        <dt>Betrag</dt>
        <dd v-if="isCash">
          <InputText v-model="formAmount" class="field-input" />
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

        <dt>Verwendung</dt>
        <dd v-if="isCash">
          <Textarea v-model="formPurpose" class="field-input" rows="3" auto-resize />
        </dd>
        <dd v-else class="multiline">{{ tx.purpose ?? '—' }}</dd>
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
      <h2>KI-Vorschläge</h2>
      <ul class="ai-list">
        <li v-for="t in aiTags()" :key="t.name" class="ai-item">
          <span class="name">{{ t.name }}</span>
          <span class="confidence">{{ t.confidence !== null ? (t.confidence * 100).toFixed(0) + '%' : '—' }}</span>
          <Button
            label="Übernehmen"
            size="small"
            :loading="promoting === t.name"
            @click="promote(t.name)"
          />
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

    <!-- Actions -->
    <div v-if="tx" class="page-actions">
      <Button
        label="Speichern"
        icon="pi pi-save"
        :disabled="!isDirty"
        :loading="saving"
        @click="save"
      />
      <Button
        v-if="isCash"
        label="Löschen"
        icon="pi pi-trash"
        severity="danger"
        :loading="deleting"
        @click="deleteTx"
      />
    </div>
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
}
.page-header h1 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  grid-template-columns: auto 1fr;
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
  word-break: break-word;
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
.ai-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.ai-item {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.5rem;
  align-items: center;
}
.ai-item .confidence {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
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
