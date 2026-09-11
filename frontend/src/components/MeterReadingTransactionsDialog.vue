<script setup lang="ts">
/**
 * "Zahlung verknüpfen" on a reading (Issue #792, Etappe 8 / #1018).
 *
 * Lists the finance transactions already linked to the reading and offers the
 * existing finance search (ACL-filtered by the backend) to link more. The
 * search window defaults to ±45 days around the reading, because the bill or
 * advance payment a reading belongs to is usually booked close to it.
 */
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import {
  listReadingTransactions,
  linkReadingTransaction,
  unlinkReadingTransaction,
  type LinkedTransaction,
  type Reading,
} from '../api/meters'
import { listTransactions, type Transaction } from '../api/finance'
import { toLocalIsoDate } from '../utils/dateFormat'

const props = defineProps<{
  visible: boolean
  reading: Reading | null
  canEdit: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'changed', readingId: number, count: number): void
}>()

const linked = ref<LinkedTransaction[]>([])
const loadingLinked = ref(false)
const results = ref<Transaction[]>([])
const searching = ref(false)
const query = ref('')
const error = ref('')
const busyIds = ref<Set<number>>(new Set())

const linkedIds = computed(() => new Set(linked.value.map((item) => item.transactionId)))

function fmtCurrency(value: number | string, currency = 'EUR') {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(n)
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function searchWindow(): { from: string; to: string } {
  const base = props.reading ? new Date(props.reading.takenAt) : new Date()
  const from = new Date(base.getTime() - 45 * 86_400_000)
  const to = new Date(base.getTime() + 45 * 86_400_000)
  return { from: toLocalIsoDate(from), to: toLocalIsoDate(to) }
}

async function loadLinked() {
  if (!props.reading) return
  loadingLinked.value = true
  error.value = ''
  try {
    linked.value = (await listReadingTransactions(props.reading.id)).items
  } catch (err: any) {
    error.value = err?.message || 'Verknüpfungen konnten nicht geladen werden'
  } finally {
    loadingLinked.value = false
  }
}

async function search() {
  if (!props.reading) return
  searching.value = true
  error.value = ''
  try {
    const q = query.value.trim()
    const window = q ? {} : searchWindow()
    const res = await listTransactions({ q: q || undefined, ...window, limit: 25 })
    results.value = res.items
  } catch (err: any) {
    error.value = err?.message || 'Suche fehlgeschlagen'
    results.value = []
  } finally {
    searching.value = false
  }
}

async function link(tx: Transaction) {
  if (!props.reading || busyIds.value.has(tx.id)) return
  busyIds.value.add(tx.id)
  try {
    await linkReadingTransaction(props.reading.id, tx.id)
    await loadLinked()
    emit('changed', props.reading.id, linked.value.length)
  } catch (err: any) {
    error.value = err?.message || 'Verknüpfen fehlgeschlagen'
  } finally {
    busyIds.value.delete(tx.id)
  }
}

async function unlink(item: LinkedTransaction) {
  if (!props.reading || busyIds.value.has(item.transactionId)) return
  busyIds.value.add(item.transactionId)
  try {
    await unlinkReadingTransaction(props.reading.id, item.transactionId)
    await loadLinked()
    emit('changed', props.reading.id, linked.value.length)
  } catch (err: any) {
    error.value = err?.message || 'Lösen fehlgeschlagen'
  } finally {
    busyIds.value.delete(item.transactionId)
  }
}

watch(
  () => [props.visible, props.reading?.id] as const,
  ([visible]) => {
    if (!visible || !props.reading) return
    query.value = ''
    results.value = []
    void loadLinked()
    if (props.canEdit) void search()
  },
  { immediate: true },
)
</script>

<template>
  <Dialog
    :visible="visible"
    header="Zahlungen zur Ablesung"
    modal
    :style="{ width: '40rem', maxWidth: '95vw' }"
    @update:visible="emit('update:visible', $event)"
  >
    <p v-if="reading" class="hint">
      Ablesung vom {{ fmtDate(reading.takenAt) }} — Abschläge, Rechnungen oder Erstattungen, die zu
      dieser Ablesung gehören.
    </p>

    <Message v-if="error" severity="error" closable @close="error = ''">{{ error }}</Message>

    <h3>Verknüpft</h3>
    <div v-if="loadingLinked" class="info"><i class="pi pi-spin pi-spinner" /> Lädt…</div>
    <div v-else-if="linked.length === 0" class="info">Noch keine Zahlung verknüpft.</div>
    <ul v-else class="tx-list">
      <li v-for="item in linked" :key="item.transactionId" class="tx-row">
        <span class="tx-date">{{ fmtDate(item.bookingDate) }}</span>
        <span class="tx-text">
          <strong>{{ item.counterparty ?? '–' }}</strong>
          <span class="tx-purpose">{{ item.purpose ?? '' }}</span>
        </span>
        <span class="tx-amount" :class="{ negative: item.amount < 0 }">{{ fmtCurrency(item.amount, item.currencyCode) }}</span>
        <Button
          v-if="canEdit"
          icon="pi pi-times"
          text
          rounded
          size="small"
          severity="secondary"
          v-tooltip.left="'Verknüpfung lösen'"
          :loading="busyIds.has(item.transactionId)"
          @click="unlink(item)"
        />
      </li>
    </ul>

    <template v-if="canEdit">
      <h3>Zahlung suchen</h3>
      <div class="search-row">
        <InputText
          v-model="query"
          placeholder="Empfänger, Verwendungszweck oder Betrag — leer: ±45 Tage um die Ablesung"
          class="search-input"
          @keyup.enter="search"
        />
        <Button icon="pi pi-search" label="Suchen" size="small" :loading="searching" @click="search" />
      </div>
      <div v-if="searching" class="info"><i class="pi pi-spin pi-spinner" /> Suche…</div>
      <div v-else-if="results.length === 0" class="info">Keine Buchungen gefunden.</div>
      <ul v-else class="tx-list">
        <li v-for="tx in results" :key="tx.id" class="tx-row">
          <span class="tx-date">{{ fmtDate(tx.booking_date) }}</span>
          <span class="tx-text">
            <strong>{{ tx.counterparty ?? '–' }}</strong>
            <span class="tx-purpose">{{ tx.purpose ?? '' }}</span>
          </span>
          <span class="tx-amount" :class="{ negative: Number(tx.amount) < 0 }">{{ fmtCurrency(tx.amount, tx.currency_code) }}</span>
          <Button
            :icon="linkedIds.has(tx.id) ? 'pi pi-check' : 'pi pi-link'"
            text
            rounded
            size="small"
            :severity="linkedIds.has(tx.id) ? 'success' : 'primary'"
            :disabled="linkedIds.has(tx.id)"
            v-tooltip.left="linkedIds.has(tx.id) ? 'Bereits verknüpft' : 'Verknüpfen'"
            :loading="busyIds.has(tx.id)"
            @click="link(tx)"
          />
        </li>
      </ul>
    </template>

    <template #footer>
      <Button label="Schließen" text @click="emit('update:visible', false)" />
    </template>
  </Dialog>
</template>

<style scoped>
.hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
h3 {
  margin: 1rem 0 0.4rem;
  font-size: 0.9rem;
  color: var(--p-text-color);
}
.info {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.tx-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.tx-row {
  display: grid;
  grid-template-columns: 5.5rem minmax(0, 1fr) auto auto;
  gap: 0.5rem;
  align-items: center;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-hover-background);
  font-size: 0.85rem;
}
.tx-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.tx-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tx-text strong,
.tx-purpose {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tx-purpose {
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
}
.tx-amount {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tx-amount.negative {
  color: var(--p-tag-danger-color);
}
.search-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.search-input {
  flex: 1;
  min-width: 0;
}
@media (max-width: 560px) {
  .tx-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .tx-date {
    grid-column: 1 / -1;
  }
}
</style>
