<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import DatePicker from 'primevue/datepicker'
import Button from 'primevue/button'
import TagAutoComplete from '../../components/finance/TagAutoComplete.vue'
import Message from 'primevue/message'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useTagsStore } from '../../stores/finance/tags'
import { recentCashRecipients, type RecentRecipient } from '../../api/finance'

const route = useRoute()
const router = useRouter()
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

const recentRecipients = ref<RecentRecipient[]>([])

const cashAccounts = computed(() =>
  accountsStore.items.filter((a) => a.type_kind === 'bargeld'),
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
})

function applyRecipient(r: RecentRecipient) {
  counterparty.value = r.counterparty
  // Under "zuletzt verwendet", badges should only show the name, not tags.
  // But applying them still brings the tags. The issue description says:
  // "Unter zuletzt verwendet sollen die Badges nur den Namen Empfänger darstellen und nicht die liste der Tags."
  // This refers to the UI of the badges themselves.
}

function setDate(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  bookingDate.value = d
}

function toIso(d: Date): string {
  // Fix timezone offset for ISO date
  const offset = d.getTimezoneOffset()
  const localDate = new Date(d.getTime() - offset * 60 * 1000)
  return localDate.toISOString().slice(0, 10)
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
  if (!counterparty.value.trim()) {
    error.value = 'Empfänger ist ein Pflichtfeld.'
    return
  }
  const signedAmount = isExpense.value ? -Math.abs(amount.value) : Math.abs(amount.value)
  saving.value = true
  try {
    const created = await txStore.create({
      account_id: accountId.value,
      booking_date: toIso(bookingDate.value),
      amount: signedAmount,
      counterparty: counterparty.value.trim(),
      purpose: purpose.value.trim() || undefined,
      tags: tags.value,
    })
    tagsStore.addLocal(tags.value)
    void router.push({ name: 'finance-transaction-detail', params: { id: created.id } })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="cash-header">
      <Button icon="pi pi-chevron-left" severity="secondary" rounded aria-label="Zurück" @click="router.back()" />
      <h1>Bargeldbuchung</h1>
    </header>

    <Message v-if="error" severity="error" :closable="true" @close="error = null">
      {{ error }}
    </Message>

    <div class="field">
      <label>Buchungsdatum</label>
      <div class="date-row">
        <DatePicker v-model="bookingDate" date-format="dd.mm.yy" show-icon fluid />
        <div class="date-presets">
          <Button label="Heute" size="small" severity="secondary" @click="setDate(0)" />
          <Button label="Gestern" size="small" severity="secondary" @click="setDate(-1)" />
        </div>
      </div>
    </div>

    <div v-if="cashAccounts.length > 0" class="account-name">
      Konto: <strong>{{ accountsStore.byId(accountId ?? -1)?.label ?? '…' }}</strong>
    </div>
    <Message v-else severity="warn" :closable="false">
      Kein Bargeldkonto (Typ „bargeld") vorhanden. Bitte zuerst ein Konto anlegen.
    </Message>

    <!-- Betrag + Vorzeichen -->
    <div class="amount-block">
      <Button
        class="sign-btn"
        :label="isExpense ? '− Ausgabe' : '+ Einnahme'"
        :severity="isExpense ? 'danger' : 'success'"
        @click="isExpense = !isExpense"
      />
      <InputNumber
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

    <!-- Empfänger -->
    <div class="field">
      <label class="field-label">Empfänger <span class="req">*</span></label>
      <input
        v-model="counterparty"
        type="text"
        class="p-inputtext p-component recipient-input"
        placeholder="Name eingeben …"
      />
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
        text
        @click="router.back()"
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
.cash-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.cash-header h1 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
}
.account-select {
  width: 100%;
}
.account-name {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
  padding: 0.25rem 0;
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
.save-btn {
  width: 100%;
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
  flex-wrap: wrap;
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
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  cursor: pointer;
  font-size: 0.85rem;
  font-family: inherit;
  color: var(--p-text-color);
  transition: background 0.1s;
}
.recent-badge:hover {
  background: var(--p-primary-50, rgba(0,0,0,0.06));
}
.recent-tags {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
</style>
