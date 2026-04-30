<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import {
  listAnomalies,
  acknowledgeAnomaly,
  type AnomalyItem,
} from '../../api/finance'

const router = useRouter()

const anomalies = ref<AnomalyItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const acknowledging = ref<Set<number>>(new Set())

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

/**
 * For duplicate anomalies we know two transactions: the newer one (item.transaction_id)
 * and the original (details.original_transaction_id). Other types have just one.
 */
function transactionLinks(item: AnomalyItem): { id: number; label: string }[] {
  const links: { id: number; label: string }[] = []
  if (item.type === 'duplicate') {
    const original = Number(item.details.original_transaction_id ?? 0)
    if (original > 0) links.push({ id: original, label: 'Original öffnen' })
    if (item.transaction_id) links.push({ id: item.transaction_id, label: 'Duplikat öffnen' })
  } else if (item.transaction_id) {
    links.push({ id: item.transaction_id, label: 'Buchung öffnen' })
  }
  return links
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
  return `${prev.toFixed(2)} € → ${curr.toFixed(2)} €`
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
          <div class="card-actions">
            <Button
              v-for="link in transactionLinks(item)"
              :key="link.id"
              icon="pi pi-external-link"
              :label="link.label"
              severity="secondary"
              text
              size="small"
              @click="openTransactionId(link.id)"
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
</style>
