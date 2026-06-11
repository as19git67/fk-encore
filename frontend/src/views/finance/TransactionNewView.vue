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
import { recentCashRecipients, searchRecipients, type RecentRecipient } from '../../api/finance'
import { useModuleBack } from '../../composables/useModuleBack'

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

const cashAccounts = computed(() =>
  accountsStore.items.filter(
    (a) => a.type_kind === 'bargeld' && !a.closed_at,
  ),
)

onMounted(async () => {
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
}

function toIso(d: Date): string {
  return toLocalIsoDate(d)
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
  saving.value = true
  try {
    await txStore.create({
      account_id: accountId.value,
      booking_date: toIso(bookingDate.value),
      amount: signedAmount,
      counterparty: counterpartyName,
      purpose: purpose.value.trim() || undefined,
      tags: tags.value,
    })
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
        <DatePicker v-model="bookingDate" date-format="dd.mm.yy" show-icon fluid />
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

    <!-- Aktionen -->
    <div class="actions-row">
      <Button
        class="save-btn"
        label="Speichern"
        icon="pi pi-check"
        :loading="saving"
        :disabled="!amount || !counterparty.trim() || !accountId"
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
  max-width: 32rem;
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
