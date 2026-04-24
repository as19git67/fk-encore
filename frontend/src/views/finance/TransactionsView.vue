<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useAccountsStore } from '../../stores/finance/accounts'
import type { Transaction } from '../../api/finance'
import BatchTagDialog from '../../components/finance/BatchTagDialog.vue'

const store = useTransactionsStore()
const accountsStore = useAccountsStore()
const router = useRouter()

const filters = ref<{
  accountId: number | null
  from: Date | null
  to: Date | null
}>({ accountId: null, from: null, to: null })

const selection = ref<Transaction[]>([])
const batchDialogOpen = ref(false)

function toIso(d: Date | null): string | undefined {
  if (!d) return undefined
  return d.toISOString().slice(0, 10)
}

async function applyFilters() {
  await store.refresh({
    accountId: filters.value.accountId ?? undefined,
    from: toIso(filters.value.from),
    to: toIso(filters.value.to),
    limit: 100,
  })
}

function clearFilters() {
  filters.value = { accountId: null, from: null, to: null }
  void applyFilters()
}

onMounted(async () => {
  if (accountsStore.items.length === 0) await accountsStore.refresh()
  await store.refresh({ limit: 100 })
})

function formatAmount(amount: string, currency: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
  }).format(Number(amount))
}

function currencyOf(accountId: number): string {
  return accountsStore.byId(accountId)?.currency_code ?? 'EUR'
}

function openBatch() {
  if (selection.value.length === 0) return
  batchDialogOpen.value = true
}

async function afterBatch() {
  selection.value = []
  batchDialogOpen.value = false
  await applyFilters()
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Umsätze</h1>
      <div>
        <Button
          label="Manuelle Buchung"
          icon="pi pi-plus"
          severity="secondary"
          @click="router.push({ name: 'finance-transaction-new' })"
        />
      </div>
    </header>

    <Message v-if="store.error" severity="error" :closable="false">{{ store.error }}</Message>

    <section class="filters">
      <label>
        <span>Konto</span>
        <Select
          v-model="filters.accountId"
          :options="accountsStore.items"
          optionLabel="label"
          optionValue="id"
          placeholder="Alle"
          show-clear
        />
      </label>
      <label>
        <span>Von</span>
        <DatePicker v-model="filters.from" date-format="yy-mm-dd" show-button-bar />
      </label>
      <label>
        <span>Bis</span>
        <DatePicker v-model="filters.to" date-format="yy-mm-dd" show-button-bar />
      </label>
      <div class="filter-actions">
        <Button label="Anwenden" @click="applyFilters" />
        <Button label="Leeren" severity="secondary" text @click="clearFilters" />
      </div>
    </section>

    <div class="toolbar">
      <span class="selected-count">
        {{ selection.length }} / {{ store.items.length }} ausgewählt
      </span>
      <Button
        label="Tags auf Auswahl anwenden"
        icon="pi pi-tags"
        :disabled="selection.length === 0"
        @click="openBatch"
      />
    </div>

    <DataTable
      v-model:selection="selection"
      :value="store.items"
      :loading="store.loading"
      dataKey="id"
      :rowHover="true"
      :paginator="true"
      :rows="20"
      striped-rows
      @row-click="(e) => router.push({ name: 'finance-transaction-detail', params: { id: (e.data as { id: number }).id } })"
    >
      <Column selectionMode="multiple" headerStyle="width: 3rem" @click.stop />
      <Column field="booking_date" header="Datum" />
      <Column field="counterparty" header="Gegenseite" />
      <Column field="purpose" header="Verwendungszweck" />
      <Column header="Betrag">
        <template #body="{ data }">
          {{ formatAmount(data.amount, currencyOf(data.account_id)) }}
        </template>
      </Column>
      <Column header="Tags">
        <template #body="{ data }">
          <Tag
            v-for="t in data.tags"
            :key="t.name + t.source"
            :severity="t.source === 'ai' ? 'secondary' : 'info'"
            :value="t.name"
            class="tag-chip"
          />
        </template>
      </Column>
    </DataTable>

    <p class="hint">Summe Auswahl: {{ selection.length }} Buchungen</p>

    <BatchTagDialog
      v-model:visible="batchDialogOpen"
      :transaction-ids="selection.map((t) => t.id)"
      @done="afterBatch"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.page-header h1 {
  margin: 0;
}
.filters {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: flex-end;
  padding: 0.75rem;
  background: var(--p-surface-50);
  border-radius: 0.5rem;
}
.filters label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 12rem;
}
.filter-actions {
  display: flex;
  gap: 0.5rem;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.selected-count {
  color: var(--p-text-muted-color);
}
.tag-chip {
  margin-right: 0.25rem;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
}
</style>
