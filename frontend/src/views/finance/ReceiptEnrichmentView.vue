<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import DocumentThumbnail from '../../components/DocumentThumbnail.vue'
import * as api from '../../api/finance'
import type { ReceiptEnrichmentItem } from '../../api/finance'
import { useRealtimeEvent } from '../../composables/useRealtime'

const router = useRouter()

const items = ref<ReceiptEnrichmentItem[]>([])
const loading = ref(false)
const loadError = ref('')
const applying = ref<number | null>(null)
const dismissing = ref<number | null>(null)
const info = ref('')

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await api.getPendingReceiptEnrichments()
    items.value = res.items
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Laden.'
  } finally {
    loading.value = false
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'ready': return 'Erkannt'
    case 'classifying': return 'Wird analysiert…'
    case 'extracting': return 'Text wird gelesen…'
    case 'pending': return 'Wartend…'
    case 'failed': return 'Fehler'
    default: return status
  }
}

function statusSeverity(status: string): 'success' | 'warn' | 'danger' | 'info' {
  switch (status) {
    case 'ready': return 'success'
    case 'failed': return 'danger'
    default: return 'warn'
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '–'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatAmount(amount: string): string {
  const n = Number(amount)
  if (Number.isNaN(n)) return amount
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n)
}

interface EnrichedField {
  label: string
  field: keyof api.UpdateTransactionInput
  current: string
  suggested: string
}

function enrichedFields(item: ReceiptEnrichmentItem): EnrichedField[] {
  const fields: EnrichedField[] = []
  if (item.doc_sender?.trim() && !item.counterparty?.trim()) {
    fields.push({
      label: 'Zahlungsempfänger',
      field: 'counterparty',
      current: item.counterparty ?? '–',
      suggested: item.doc_sender.trim(),
    })
  }
  if (item.doc_date && item.doc_date !== item.booking_date?.slice(0, 10)) {
    fields.push({
      label: 'Belegdatum',
      field: 'booking_date',
      current: formatDate(item.booking_date),
      suggested: formatDate(item.doc_date),
    })
  }
  return fields
}

const pendingCount = computed(() =>
  items.value.filter(i => i.doc_status === 'ready' && enrichedFields(i).length > 0).length,
)
const processingCount = computed(() =>
  items.value.filter(i => i.doc_status !== 'ready').length,
)

async function applyAll(item: ReceiptEnrichmentItem) {
  const fields = enrichedFields(item)
  if (fields.length === 0) return
  applying.value = item.transaction_id
  try {
    const input: api.UpdateTransactionInput = {}
    for (const f of fields) {
      if (f.field === 'counterparty') input.counterparty = f.suggested
      if (f.field === 'booking_date') input.booking_date = item.doc_date!
    }
    await api.updateTransaction(item.transaction_id, input)
    items.value = items.value.filter(i => i.transaction_id !== item.transaction_id)
    info.value = 'Buchung aktualisiert.'
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Übernehmen.'
  } finally {
    applying.value = null
  }
}

async function dismiss(item: ReceiptEnrichmentItem) {
  dismissing.value = item.transaction_id
  try {
    // Clear the receipt link so this item won't appear again
    await api.updateTransaction(item.transaction_id, {})
    items.value = items.value.filter(i => i.transaction_id !== item.transaction_id)
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Verwerfen.'
  } finally {
    dismissing.value = null
  }
}

function openTransaction(id: number) {
  router.push({ name: 'finance-transaction-detail', params: { id } })
}

function openDocument(id: number) {
  router.push({ name: 'dokumente-detail', params: { id } })
}

useRealtimeEvent('finance', 'receipt.enriched', () => {
  void load()
})

onMounted(load)
</script>

<template>
  <div class="re-view">
    <header class="re-header">
      <div class="re-header-left">
        <h2 class="re-title">
          Belegabgleich
          <span v-if="pendingCount" class="re-count">({{ pendingCount }})</span>
        </h2>
        <p class="re-sub">
          Buchungen mit fotografierten Belegen, die vom Server erkannt wurden.
        </p>
      </div>
      <div class="re-header-right">
        <Button icon="pi pi-refresh" text rounded :loading="loading" @click="load" />
      </div>
    </header>

    <Message v-if="info" severity="success" :closable="true" @close="info = ''">
      {{ info }}
    </Message>
    <Message v-if="loadError" severity="error" :closable="true" @close="loadError = ''">
      {{ loadError }}
    </Message>

    <div v-if="!loading && items.length === 0 && !loadError" class="re-empty">
      <i class="pi pi-check-circle" />
      <p>Keine Belege zum Abgleichen.</p>
    </div>

    <ul class="re-list">
      <li v-for="item in items" :key="item.transaction_id" class="re-card">
        <button type="button" class="re-thumb" @click="openDocument(item.document_id)">
          <DocumentThumbnail :id="item.document_id" alt="Beleg" />
        </button>

        <div class="re-body">
          <div class="re-row1">
            <span class="re-amount">{{ formatAmount(item.amount) }}</span>
            <Tag :severity="statusSeverity(item.doc_status)" :value="statusLabel(item.doc_status)" />
          </div>

          <div class="re-meta">
            <span><i class="pi pi-calendar" /> {{ formatDate(item.booking_date) }}</span>
            <span v-if="item.counterparty"><i class="pi pi-building" /> {{ item.counterparty }}</span>
          </div>

          <div v-if="item.doc_status === 'ready' && enrichedFields(item).length > 0" class="re-enrichments">
            <div v-for="field in enrichedFields(item)" :key="field.field" class="re-field">
              <span class="re-field-label">{{ field.label }}:</span>
              <span class="re-field-current">{{ field.current }}</span>
              <i class="pi pi-arrow-right re-arrow" />
              <span class="re-field-suggested">{{ field.suggested }}</span>
            </div>
          </div>

          <div v-if="item.doc_status !== 'ready'" class="re-processing">
            <i class="pi pi-spin pi-spinner" /> Beleg wird noch verarbeitet…
          </div>

          <div v-if="item.doc_status === 'ready' && enrichedFields(item).length > 0" class="re-actions">
            <Button
              label="Übernehmen"
              icon="pi pi-check"
              size="small"
              :loading="applying === item.transaction_id"
              @click="applyAll(item)"
            />
            <Button
              label="Bearbeiten"
              icon="pi pi-pencil"
              size="small"
              severity="secondary"
              outlined
              @click="openTransaction(item.transaction_id)"
            />
            <Button
              label="Verwerfen"
              icon="pi pi-times"
              size="small"
              severity="secondary"
              text
              :loading="dismissing === item.transaction_id"
              @click="dismiss(item)"
            />
          </div>
        </div>
      </li>
    </ul>

    <div v-if="processingCount > 0 && pendingCount === 0 && !loading" class="re-hint">
      <i class="pi pi-info-circle" />
      {{ processingCount }} {{ processingCount === 1 ? 'Beleg wird' : 'Belege werden' }} noch verarbeitet.
      Die Ergebnisse erscheinen hier automatisch.
    </div>
  </div>
</template>

<style scoped>
.re-view {
  max-width: 960px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.re-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.re-title {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
}
.re-count {
  font-weight: 400;
  color: var(--p-text-muted-color);
  margin-left: 6px;
}
.re-sub {
  margin: 4px 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.re-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.re-empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 48px 16px;
}
.re-empty .pi-check-circle {
  font-size: 2.5rem;
  color: var(--p-green-500, #22c55e);
  margin-bottom: 12px;
}
.re-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.re-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 12px;
}
.re-thumb {
  flex: 0 0 56px;
  width: 56px;
  height: 72px;
  border: 0;
  padding: 0;
  background: var(--p-content-hover-background);
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
}
.re-thumb :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.re-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.re-row1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.re-amount {
  font-weight: 600;
  font-size: 1.05rem;
}
.re-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.re-meta i {
  margin-right: 3px;
}
.re-enrichments {
  background: var(--p-content-hover-background);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85rem;
}
.re-field {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.re-field-label {
  color: var(--p-text-muted-color);
  white-space: nowrap;
}
.re-field-current {
  color: var(--p-text-muted-color);
  text-decoration: line-through;
}
.re-field-suggested {
  font-weight: 600;
  color: var(--p-primary-color);
}
.re-arrow {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.re-processing {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.re-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.re-hint {
  text-align: center;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  padding: 16px;
}
.re-hint i {
  margin-right: 4px;
}
</style>
