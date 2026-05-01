<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import InputNumber from 'primevue/inputnumber'
import Button from 'primevue/button'
import TagAutoComplete from '../../components/finance/TagAutoComplete.vue'
import Message from 'primevue/message'
import Select from 'primevue/select'
import { useAccountsStore } from '../../stores/finance/accounts'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useTagsStore } from '../../stores/finance/tags'
import { recentCashRecipients, type RecentRecipient } from '../../api/finance'

const router = useRouter()
const accountsStore = useAccountsStore()
const txStore = useTransactionsStore()
const tagsStore = useTagsStore()

const accountId = ref<number | null>(null)
const amount = ref<number | null>(null)
const isExpense = ref(true)
const counterparty = ref('')
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
  if (cashAccounts.value.length === 1) {
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
  tags.value = [...r.tags]
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
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
      booking_date: toIso(new Date()),
      amount: signedAmount,
      counterparty: counterparty.value.trim(),
      tags: tags.value,
    })
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

    <!-- Konto-Auswahl (nur wenn mehrere Bargeldkonten) -->
    <Select
      v-if="cashAccounts.length > 1"
      v-model="accountId"
      :options="cashAccounts"
      option-label="label"
      option-value="id"
      placeholder="Bargeldkonto wählen …"
      class="account-select"
    />
    <div v-else-if="cashAccounts.length === 1" class="account-name">
      {{ cashAccounts[0]!.label }}
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

    <!-- Buchen-Button -->
    <Button
      class="save-btn"
      label="Buchen"
      :loading="saving"
      :disabled="!amount || !counterparty.trim() || !accountId"
      @click="save"
    />

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
          <span v-if="r.tags.length > 0" class="recent-tags">· {{ r.tags.join(', ') }}</span>
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
