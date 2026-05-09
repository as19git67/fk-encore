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
import { toLocalIsoDate } from '../../utils/dateFormat'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useAccountsStore } from '../../stores/finance/accounts'
import type { MandateHistoryItem, Transaction } from '../../api/finance'
import * as api from '../../api/finance'
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

// ── Recurring expansion ────────────────────────────────────────────────────
// Lazily fetched per-row when the user clicks the expander, so the page
// load isn't penalised for transactions the user never inspects.
type RecurringState = {
  loading: boolean
  error: string | null
  counterparty: string | null
  items: MandateHistoryItem[]
}
const recurringByTx = ref<Record<number, RecurringState>>({})
const expandedRows = ref<Record<number, boolean>>({})

async function loadRecurring(transactionId: number) {
  const existing = recurringByTx.value[transactionId]
  if (existing && !existing.error) return // cached
  recurringByTx.value = {
    ...recurringByTx.value,
    [transactionId]: {
      loading: true,
      error: null,
      counterparty: existing?.counterparty ?? null,
      items: existing?.items ?? [],
    },
  }
  try {
    const res = await api.getRelatedRecurringTransactions(transactionId)
    recurringByTx.value = {
      ...recurringByTx.value,
      [transactionId]: {
        loading: false,
        error: null,
        counterparty: res.counterparty,
        items: res.items,
      },
    }
  } catch (err) {
    recurringByTx.value = {
      ...recurringByTx.value,
      [transactionId]: {
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        counterparty: null,
        items: [],
      },
    }
  }
}

function onRowExpand(event: { data: Transaction }) {
  void loadRecurring(event.data.id)
}

function recurringPartners(transactionId: number): MandateHistoryItem[] {
  const state = recurringByTx.value[transactionId]
  if (!state) return []
  return state.items.filter((it) => it.id !== transactionId)
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

function toIso(d: Date | null): string | undefined {
  if (!d) return undefined
  return toLocalIsoDate(d)
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
      v-model:expandedRows="expandedRows"
      :value="store.items"
      :loading="store.loading"
      dataKey="id"
      :rowHover="true"
      :paginator="true"
      :rows="20"
      striped-rows
      @row-expand="onRowExpand"
      @row-click="(e) => router.push({ name: 'finance-transaction-detail', params: { id: (e.data as { id: number }).id } })"
    >
      <Column selectionMode="multiple" headerStyle="width: 3rem" @click.stop />
      <Column expander headerStyle="width: 3rem" @click.stop />
      <Column field="booking_date" header="Datum" />
      <Column field="counterparty" header="Gegenseite" />
      <Column field="purpose" header="Verwendungszweck" class="mobile-hidden" headerClass="mobile-hidden" />
      <Column header="Betrag">
        <template #body="{ data }">
          {{ formatAmount(data.amount, currencyOf(data.account_id)) }}
        </template>
      </Column>
      <Column header="Tags" class="mobile-hidden" headerClass="mobile-hidden">
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
      <template #expansion="{ data }">
        <div class="recurring-block" @click.stop>
          <h3 class="recurring-title">
            Wiederkehrende Buchungen
            <span v-if="recurringByTx[data.id]?.counterparty" class="recurring-subtitle">
              · {{ recurringByTx[data.id]!.counterparty }}
            </span>
          </h3>
          <Message
            v-if="recurringByTx[data.id]?.error"
            severity="error"
            :closable="false"
          >
            {{ recurringByTx[data.id]!.error }}
          </Message>
          <div v-else-if="recurringByTx[data.id]?.loading" class="hint">Lädt …</div>
          <ul
            v-else-if="recurringPartners(data.id).length > 0"
            class="recurring-list"
          >
            <li
              v-for="it in recurringPartners(data.id)"
              :key="it.id"
              class="recurring-row"
              @click.stop="router.push({ name: 'finance-transaction-detail', params: { id: it.id } })"
            >
              <span class="recurring-date">{{ formatRecurringDate(it.booking_date) }}</span>
              <span class="recurring-amount">{{ formatAmount(it.amount, currencyOf(data.account_id)) }}</span>
              <span class="recurring-purpose">{{ it.purpose ?? '' }}</span>
            </li>
          </ul>
          <p v-else class="hint">Keine weiteren Buchungen.</p>
        </div>
      </template>
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
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
  .filters {
    padding: 0.5rem;
  }
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

.recurring-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
}
.recurring-title {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--p-text-muted-color);
}
.recurring-subtitle {
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
  grid-template-columns: 6.5rem 7rem 1fr;
  gap: 0.5rem;
  padding: 0.35rem 0.25rem;
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
</style>
