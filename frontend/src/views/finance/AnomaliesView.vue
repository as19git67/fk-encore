<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import {
  listAnomalies,
  acknowledgeAnomaly,
  getMandateHistory,
  type AnomalyItem,
  type DuplicateTransactionInfo,
  type MandateHistoryItem,
} from '../../api/finance'

const router = useRouter()

const anomalies = ref<AnomalyItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const acknowledging = ref<Set<number>>(new Set())
const expandedHistory = ref<Set<number>>(new Set())
const historyByAnomaly = ref<Map<number, MandateHistoryItem[]>>(new Map())
const loadingHistory = ref<Set<number>>(new Set())

const typeFilter = ref<string>('all')
const typeOptions = [
  { label: 'Alle', value: 'all' },
  { label: 'Betragsänderung', value: 'amount_change' },
  { label: 'Möglicherweise doppelt', value: 'duplicate' },
  { label: 'Neuer Lastschrift', value: 'new_mandate' },
]

const filtered = computed(() =>
  typeFilter.value === 'all'
    ? anomalies.value
    : anomalies.value.filter((a) => a.type === typeFilter.value),
)

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await listAnomalies()
    anomalies.value = res.anomalies
  } catch (e: any) {
    error.value = e?.message ?? 'Fehler beim Laden'
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function acknowledge(item: AnomalyItem) {
  acknowledging.value.add(item.id)
  try {
    await acknowledgeAnomaly(item.id)
    anomalies.value = anomalies.value.filter((a) => a.id !== item.id)
  } catch (e: any) {
    error.value = e?.message ?? 'Konnte Anomalie nicht quittieren'
  } finally {
    acknowledging.value.delete(item.id)
  }
}

async function acknowledgeAll() {
  const items = filtered.value.slice()
  for (const item of items) {
    await acknowledge(item)
  }
}

function openTransactionId(id: number) {
  void router.push({
    name: 'finance-transaction-detail',
    params: { id },
  })
}

async function toggleHistory(item: AnomalyItem) {
  if (!item.mandate_id) return
  if (expandedHistory.value.has(item.id)) {
    expandedHistory.value.delete(item.id)
    return
  }
  expandedHistory.value.add(item.id)
  if (historyByAnomaly.value.has(item.id)) return
  loadingHistory.value.add(item.id)
  try {
    const res = await getMandateHistory(item.mandate_id)
    historyByAnomaly.value.set(item.id, res.items)
  } catch (e: any) {
    error.value = e?.message ?? 'Verlauf konnte nicht geladen werden'
    expandedHistory.value.delete(item.id)
  } finally {
    loadingHistory.value.delete(item.id)
  }
}

function formatAmount(raw: string): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
  }).format(n)
}

/** For non-duplicate types: single link to the transaction. */
function singleTransactionId(item: AnomalyItem): number | null {
  if (item.type === 'duplicate') return null
  return item.transaction_id
}

function dupRowLabel(tx: DuplicateTransactionInfo, item: AnomalyItem): string {
  const origId = Number(item.details.original_transaction_id ?? 0)
  return tx.id === origId ? 'Original' : 'Duplikat'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function iconFor(type: string): string {
  switch (type) {
    case 'amount_change': return 'pi pi-arrow-right-arrow-left'
    case 'duplicate': return 'pi pi-clone'
    case 'new_mandate': return 'pi pi-bell'
    default: return 'pi pi-exclamation-triangle'
  }
}

function severityClass(type: string): string {
  switch (type) {
    case 'amount_change': return 'sev-warn'
    case 'duplicate': return 'sev-danger'
    case 'new_mandate': return 'sev-info'
    default: return 'sev-default'
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case 'amount_change': return 'Betragsänderung'
    case 'duplicate': return 'Mögliches Duplikat'
    case 'new_mandate': return 'Neue Lastschrift'
    default: return type
  }
}

function formatAmountChange(item: AnomalyItem): string | null {
  if (item.type !== 'amount_change') return null
  const prev = Number(item.details.previous ?? 0)
  const curr = Number(item.details.current ?? 0)
  return `${formatAmount(String(prev))} → ${formatAmount(String(curr))}`
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Finanz-Anomalien</h1>
      <div class="header-actions">
        <Button
          icon="pi pi-refresh"
          label="Aktualisieren"
          severity="secondary"
          text
          :disabled="loading"
          @click="load"
        />
        <Button
          v-if="filtered.length > 0"
          icon="pi pi-check"
          label="Alle quittieren"
          severity="secondary"
          @click="acknowledgeAll"
        />
      </div>
    </header>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="filter-row">
      <SelectButton
        v-model="typeFilter"
        :options="typeOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
      />
    </div>

    <div v-if="loading && anomalies.length === 0" class="loading">Lädt …</div>

    <section v-else-if="filtered.length === 0" class="empty">
      <i class="pi pi-check-circle empty-icon" />
      <p>Keine offenen Anomalien.</p>
    </section>

    <ul v-else class="anomaly-list">
      <li
        v-for="item in filtered"
        :key="item.id"
        :class="['anomaly-card', severityClass(item.type)]"
      >
        <div class="card-icon">
          <i :class="iconFor(item.type)" />
        </div>

        <div class="card-body">
          <div class="card-head">
            <span class="type-label">{{ typeLabel(item.type) }}</span>
            <span class="date">{{ formatDate(item.created_at) }}</span>
          </div>
          <div class="message">{{ item.message }}</div>
          <div v-if="formatAmountChange(item)" class="diff">
            {{ formatAmountChange(item) }}
          </div>

          <div
            v-if="(item.type === 'amount_change' || item.type === 'new_mandate') && item.mandate_id"
            class="history-section"
          >
            <button
              type="button"
              class="history-toggle"
              @click="toggleHistory(item)"
            >
              <i
                :class="[
                  'pi',
                  expandedHistory.has(item.id) ? 'pi-chevron-down' : 'pi-chevron-right',
                ]"
              />
              {{ item.type === 'new_mandate' ? 'Buchungen' : 'Verlauf' }}
              {{ expandedHistory.has(item.id) ? 'ausblenden' : 'anzeigen' }}
            </button>
            <div v-if="expandedHistory.has(item.id)" class="history-body">
              <div
                v-if="loadingHistory.has(item.id) && !historyByAnomaly.get(item.id)"
                class="history-loading"
              >
                Lädt …
              </div>
              <ul
                v-else-if="(historyByAnomaly.get(item.id)?.length ?? 0) > 0"
                class="history-list"
              >
                <li
                  v-for="h in historyByAnomaly.get(item.id)"
                  :key="h.id"
                  class="history-row"
                  @click="openTransactionId(h.id)"
                >
                  <span class="history-date">{{ formatDate(h.booking_date) }}</span>
                  <span class="history-amount">{{ formatAmount(h.amount) }}</span>
                  <span class="history-purpose">{{ h.purpose ?? '' }}</span>
                </li>
              </ul>
              <div v-else class="history-empty">Keine weiteren Buchungen.</div>
            </div>
          </div>

          <!-- Inline list for duplicate anomalies -->
          <ul
            v-if="item.type === 'duplicate' && item.duplicate_transactions?.length"
            class="dup-list"
          >
            <li
              v-for="tx in item.duplicate_transactions"
              :key="tx.id"
              class="dup-row"
              @click="openTransactionId(tx.id)"
            >
              <span class="dup-label">{{ dupRowLabel(tx, item) }}</span>
              <span class="history-date">{{ formatDate(tx.booking_date) }}</span>
              <span class="history-amount">{{ formatAmount(tx.amount) }}</span>
              <span class="history-purpose">{{ tx.purpose ?? '' }}</span>
            </li>
          </ul>

          <div class="card-actions">
            <Button
              v-if="singleTransactionId(item)"
              icon="pi pi-external-link"
              label="Buchung öffnen"
              severity="secondary"
              text
              size="small"
              @click="openTransactionId(singleTransactionId(item)!)"
            />
            <Button
              icon="pi pi-check"
              label="Verstanden"
              severity="secondary"
              size="small"
              :loading="acknowledging.has(item.id)"
              @click="acknowledge(item)"
            />
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.page {
  padding: 1rem;
  max-width: 900px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.page-header h1 {
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

.filter-row {
  margin-bottom: 1rem;
}

.loading,
.empty {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--p-text-muted-color);
}

.empty-icon {
  font-size: 2.5rem;
  display: block;
  margin-bottom: 0.5rem;
  color: var(--p-primary-color);
}

.filter-row :deep(.p-selectbutton .p-button) {
  hyphens: auto;
  overflow-wrap: break-word;
  white-space: normal;
  text-align: center;
  line-height: 1.2;
}

.anomaly-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.anomaly-card {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  border-radius: 0.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-left-width: 4px;
}

.anomaly-card.sev-warn {
  border-left-color: var(--p-yellow-500, #f59e0b);
}
.anomaly-card.sev-danger {
  border-left-color: var(--p-red-500, #ef4444);
}
.anomaly-card.sev-info {
  border-left-color: var(--p-blue-500, #3b82f6);
}

.card-icon {
  flex: 0 0 auto;
  font-size: 1.5rem;
  color: var(--p-text-muted-color);
}
.sev-warn .card-icon { color: var(--p-yellow-500, #f59e0b); }
.sev-danger .card-icon { color: var(--p-red-500, #ef4444); }
.sev-info .card-icon { color: var(--p-blue-500, #3b82f6); }

.card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}

.type-label {
  font-weight: 600;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--p-text-muted-color);
}

.date {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.message {
  color: var(--p-text-color);
  line-height: 1.4;
}

.diff {
  font-family: monospace;
  font-size: 0.95rem;
  color: var(--p-text-muted-color);
}

.card-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.dup-list {
  list-style: none;
  margin: 0.4rem 0 0;
  padding: 0;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.4rem;
  display: flex;
  flex-direction: column;
}

.dup-row {
  display: grid;
  grid-template-columns: 4.5rem 6.5rem 6.5rem 1fr;
  gap: 0.5rem;
  padding: 0.35rem 0.25rem;
  border-radius: 0.25rem;
  cursor: pointer;
  align-items: baseline;
  font-size: 0.9rem;
}
.dup-row:hover {
  background: var(--p-content-hover-background);
}

.dup-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
}

.history-section {
  margin-top: 0.25rem;
}

.history-toggle {
  background: none;
  border: none;
  padding: 0.25rem 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.history-toggle:hover {
  color: var(--p-text-color);
}

.history-body {
  margin-top: 0.4rem;
  border-top: 1px solid var(--p-content-border-color);
  padding-top: 0.4rem;
}

.history-loading,
.history-empty {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  padding: 0.4rem 0;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.history-row {
  display: grid;
  grid-template-columns: 6.5rem 6.5rem 1fr;
  gap: 0.5rem;
  padding: 0.35rem 0.25rem;
  border-radius: 0.25rem;
  cursor: pointer;
  align-items: baseline;
  font-size: 0.9rem;
}
.history-row:hover {
  background: var(--p-content-hover-background);
}

.history-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.history-amount {
  font-family: monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.history-purpose {
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 540px) {
  .history-row {
    grid-template-columns: 5.5rem 6rem;
    grid-template-rows: auto auto;
  }
  .history-purpose {
    grid-column: 1 / -1;
    white-space: normal;
  }
}
</style>
