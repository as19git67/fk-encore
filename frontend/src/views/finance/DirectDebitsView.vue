<script setup lang="ts">
/**
 * Finanzen › Erwartete Zahlungen (#1526): what recurring outgoing payments
 * are still coming in a period — direct debits and transfers, never card
 * payments or cash — from the series the anomaly detector keeps. The
 * server computes the dates and the sum; this page only picks the period
 * and the channel and shows the rows, each with the series' past bookings
 * on demand.
 */
import { computed, ref, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import PageLayout from '../../components/layout/PageLayout.vue'
import ListToolbar from '../../components/layout/ListToolbar.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import { useListToolbar, useListView } from '../../composables/useListToolbar'
import {
  getMandateHistory,
  listUpcomingDebits,
  type MandateHistoryItem,
  type UpcomingChannel,
  type UpcomingDebit,
} from '../../api/finance'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'

const router = useRouter()

const periodOptions = [
  { label: 'Rest dieses Monats', value: 'month' },
  { label: 'Nächster Monat', value: 'next-month' },
  { label: 'Nächste 3 Monate', value: '3-months' },
  { label: 'Nächste 12 Monate', value: '12-months' },
]

// In the URL like every list filter, so a reload or a shared link shows
// the same period.
const periodView = useListView({ options: periodOptions, defaultValue: 'month', key: 'period' })
const period = periodView.value

const channelOptions: { label: string; value: UpcomingChannel }[] = [
  { label: 'Lastschriften und Überweisungen', value: 'all' },
  { label: 'Nur Lastschriften', value: 'direct_debit' },
  { label: 'Nur Überweisungen und Daueraufträge', value: 'transfer' },
]
const channelView = useListView({ options: channelOptions, defaultValue: 'all', key: 'channel' })
const channel = channelView.value as unknown as Ref<UpcomingChannel>

const CHANNEL_LABELS: Record<string, string> = { direct_debit: 'Lastschrift', transfer: 'Überweisung', card: 'Karte', other: 'Kanal unbekannt' }
function channelLabel(v: string | null): string {
  return CHANNEL_LABELS[v ?? 'other'] ?? CHANNEL_LABELS.other
}

/** The window for a period, in local dates. */
function windowFor(value: string, today = new Date()): { from: string; until: string } {
  const y = today.getFullYear()
  const m = today.getMonth()
  const endOf = (monthOffset: number) => toLocalIsoDate(new Date(y, m + monthOffset + 1, 0))
  switch (value) {
    case 'next-month':
      return { from: toLocalIsoDate(new Date(y, m + 1, 1)), until: endOf(1) }
    case '3-months':
      return { from: toLocalIsoDate(today), until: toLocalIsoDate(new Date(y, m + 3, today.getDate())) }
    case '12-months':
      return { from: toLocalIsoDate(today), until: toLocalIsoDate(new Date(y + 1, m, today.getDate())) }
    default:
      return { from: toLocalIsoDate(today), until: endOf(0) }
  }
}

const items = ref<UpcomingDebit[]>([])
const totalAmount = ref<string | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref<string | null>(null)

const currency = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

function formatAmount(raw: string): string {
  const n = Number(raw)
  return Number.isFinite(n) ? currency.format(n) : raw
}

function formatDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

function intervalLabel(days: number): string {
  if (days >= 26 && days <= 35) return 'monatlich'
  if (days >= 55 && days <= 66) return 'alle 2 Monate'
  if (days >= 84 && days <= 98) return 'vierteljährlich'
  if (days >= 170 && days <= 195) return 'halbjährlich'
  if (days >= 350 && days <= 380) return 'jährlich'
  if (days === 7) return 'wöchentlich'
  if (days === 14) return 'alle 2 Wochen'
  return `alle ${days} Tage`
}

const toolbar = useListToolbar({
  result: {
    loaded: () => items.value.length,
    loading: () => loading.value,
    summary: () => (totalAmount.value !== null && items.value.length > 0
      ? `Summe ${formatAmount(totalAmount.value)}`
      : undefined),
  },
})

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await listUpcomingDebits({ ...windowFor(period.value), channel: channel.value })
    items.value = res.items
    totalAmount.value = res.total_amount
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Lastschriften konnten nicht geladen werden'
  } finally {
    loading.value = false
    loaded.value = true
  }
}

watch([period, channel], load, { immediate: true })

const periodLabel = computed(
  () => periodOptions.find((o) => o.value === period.value)?.label ?? '',
)

// ── past bookings of a series, on demand ────────────────────────────────

const expanded = ref<Set<string>>(new Set())
const historyByMandate = ref<Map<number, MandateHistoryItem[]>>(new Map())
const loadingHistory = ref<Set<number>>(new Set())

function rowKey(item: UpcomingDebit): string {
  return `${item.mandate_id}-${item.expected_date}`
}

async function toggleHistory(item: UpcomingDebit) {
  const key = rowKey(item)
  if (expanded.value.has(key)) {
    expanded.value.delete(key)
    return
  }
  expanded.value.add(key)
  if (historyByMandate.value.has(item.mandate_id)) return
  loadingHistory.value.add(item.mandate_id)
  try {
    const res = await getMandateHistory(item.mandate_id)
    historyByMandate.value.set(item.mandate_id, res.items)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Verlauf konnte nicht geladen werden'
    expanded.value.delete(key)
  } finally {
    loadingHistory.value.delete(item.mandate_id)
  }
}

function openTransaction(id: number) {
  void router.push({ name: 'finance-transaction-detail', params: { id } })
}
</script>

<template>
  <PageLayout
    title="Erwartete Zahlungen"
    hint="Regelmäßige Lastschriften und Überweisungen, die im gewählten Zeitraum noch vom Konto abgehen — geschätzt aus den bisherigen Buchungen. Kartenzahlungen und Bargeld zählen nicht."
    width="wide"
    :ready="loaded"
  >
    <template #toolbar>
      <ListToolbar :model="toolbar">
        <template #actions>
          <Select
            v-model="period"
            :options="periodOptions"
            option-label="label"
            option-value="value"
            size="small"
            aria-label="Zeitraum"
            class="period-select"
          />
          <Select
            v-model="channel"
            :options="channelOptions"
            option-label="label"
            option-value="value"
            size="small"
            aria-label="Zahlungsart"
            class="period-select"
          />
        </template>
      </ListToolbar>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = null" />
    </template>

    <PageSkeleton v-if="loading && items.length === 0" variant="list" :count="6" />

    <EmptyState
      v-else-if="items.length === 0"
      icon="pi pi-calendar"
      title="Keine Zahlungen erwartet"
      :message="`Im Zeitraum „${periodLabel}“ steht nach den bisherigen Buchungen nichts mehr an.`"
    />

    <ul v-else class="debit-list">
      <li v-for="item in items" :key="rowKey(item)" class="debit-row">
        <div class="debit-main">
          <span class="debit-date">{{ formatDate(item.expected_date) }}</span>
          <span class="debit-who">
            <span class="debit-counterparty">
              {{ item.counterparty ?? 'Unbekannter Empfänger' }}
              <Tag v-if="item.overdue" severity="warn" value="überfällig" class="debit-tag" />
            </span>
            <span class="debit-meta">
              {{ item.account_label }} · {{ channelLabel(item.payment_channel) }} · {{ intervalLabel(item.interval_days) }} ·
              zuletzt {{ parseLocalDate(item.last_seen).toLocaleDateString('de-DE') }}
            </span>
          </span>
          <span class="debit-amount">{{ formatAmount(item.typical_amount) }}</span>
        </div>

        <button
          type="button"
          class="history-toggle"
          :aria-expanded="expanded.has(rowKey(item))"
          @click="toggleHistory(item)"
        >
          <i :class="['pi', expanded.has(rowKey(item)) ? 'pi-chevron-down' : 'pi-chevron-right']" aria-hidden="true" />
          Bisherige Buchungen {{ expanded.has(rowKey(item)) ? 'ausblenden' : 'anzeigen' }}
        </button>

        <div v-if="expanded.has(rowKey(item))" class="history-body">
          <div v-if="loadingHistory.has(item.mandate_id)" class="history-hint">Lädt …</div>
          <ul v-else-if="(historyByMandate.get(item.mandate_id)?.length ?? 0) > 0" class="history-list">
            <li v-for="h in historyByMandate.get(item.mandate_id)" :key="h.id">
              <button type="button" class="history-row" @click="openTransaction(h.id)">
                <span class="history-date">{{ parseLocalDate(h.booking_date.slice(0, 10)).toLocaleDateString('de-DE') }}</span>
                <span class="history-amount">{{ formatAmount(h.amount) }}</span>
                <span class="history-purpose">{{ h.purpose ?? '' }}</span>
              </button>
            </li>
          </ul>
          <div v-else class="history-hint">Keine Buchungen gefunden.</div>
        </div>
      </li>
    </ul>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.period-select {
  min-width: 12rem;
}

.debit-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.debit-row {
  padding: var(--space-3);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  min-width: 0;
}

.debit-main {
  display: grid;
  grid-template-columns: 9rem minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
}

.debit-date {
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.debit-who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.debit-counterparty {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debit-tag {
  margin-left: var(--space-2);
  vertical-align: middle;
}

.debit-meta {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debit-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}

.history-toggle {
  margin-top: var(--space-2);
  padding: 0;
  border: none;
  background: none;
  color: var(--p-primary-color);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.history-toggle:focus-visible,
.history-row:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.history-body {
  margin-top: var(--space-2);
}

.history-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.history-row {
  display: grid;
  grid-template-columns: 6.5rem 7rem minmax(0, 1fr);
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: 0.25rem;
  background: none;
  color: inherit;
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.history-row:hover {
  background: var(--p-content-hover-background);
}

.history-date,
.history-amount {
  font-variant-numeric: tabular-nums;
}

.history-purpose {
  color: var(--p-text-muted-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-hint {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

/* Below md the date moves above the name, so the amount keeps its place on
   a 360px screen. */
@media (max-width: 767px) {
  .debit-main {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .debit-date {
    grid-column: 1 / -1;
    font-size: var(--text-sm);
  }

  .history-row {
    grid-template-columns: 6.5rem minmax(0, 1fr);
  }

  .history-purpose {
    grid-column: 1 / -1;
  }
}
</style>
