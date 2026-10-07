<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Chart from 'primevue/chart'
import MultiSelect from 'primevue/multiselect'
import PageLayout from '../../components/layout/PageLayout.vue'
import ListToolbar from '../../components/layout/ListToolbar.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import { useListSearch, useListToolbar, useListView } from '../../composables/useListToolbar'
import { useMediaQuery } from '../../composables/useBreakpoint'
import type { FilterChip } from '../../components/layout/listToolbar'
import { replaceQuerySlice, updateRouteQuery } from '../../utils/routeQueryUpdate'
import {
  getPortfolio,
  getQuotes,
  refreshQuotes,
  type PortfolioAccount,
  type QuoteRange,
  type QuoteTile,
  type QuotesResponse,
} from '../../api/finance'
import {
  formatCurrency,
  formatQuantity,
  formatSignedCurrency,
  formatSignedPercent,
  gainSign,
} from '../../utils/financeFormat'

/**
 * Kurse — one tile per security the depots hold: the last price, its
 * change over a switchable range, a sparkline and the value of the
 * shares. Prices come from the quote cache (`.claude/plans/kurse.md`);
 * the page polls every minute while it is open and keeps the previous
 * tiles on screen while a reload is in flight.
 *
 * Range and depot scope live in the URL (`range`, `accounts`), so a
 * reload or a shared link shows the same page.
 */

const route = useRoute()
const router = useRouter()

// ── URL-backed scope ─────────────────────────────────────────────────
const FILTER_KEYS = ['accounts'] as const

function queryString(key: string): string {
  const v = route.query[key]
  return typeof v === 'string' ? v : ''
}

const accountIds = computed<number[]>(() =>
  queryString('accounts')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0),
)

function setQuery(patch: Partial<Record<(typeof FILTER_KEYS)[number], string>>) {
  void updateRouteQuery(router, (current) => {
    const values: Record<string, string> = {}
    for (const key of FILTER_KEYS) {
      const next = key in patch ? patch[key] : queryString(key)
      if (next) values[key] = next
    }
    return replaceQuerySlice(current, FILTER_KEYS, values)
  })
}

const RANGE_OPTIONS: { value: QuoteRange; label: string }[] = [
  { value: '1d', label: '1T' },
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
  { value: '1y', label: '1J' },
  { value: 'max', label: 'Max' },
]
const RANGE_TEXT: Record<QuoteRange, string> = {
  '1d': 'seit gestern',
  '1w': 'seit einer Woche',
  '1m': 'seit einem Monat',
  '1y': 'seit einem Jahr',
  max: 'seit Beginn',
}
const rangeView = useListView({
  options: RANGE_OPTIONS,
  defaultValue: '1m',
  key: 'range',
  storageKey: 'finance.quotes.range',
})
const range = computed(() => rangeView.value.value as QuoteRange)

const search = useListSearch({
  placeholder: 'Wertpapier, ISIN oder WKN',
  storageKey: 'finance.quotes.search',
})

// ── Data ─────────────────────────────────────────────────────────────
const data = ref<QuotesResponse | null>(null)
const loading = ref(false)
const reloading = ref(false)
const error = ref<string | null>(null)
let request = 0

async function load(silent = false) {
  const id = ++request
  if (data.value && silent) reloading.value = true
  else loading.value = true
  error.value = null
  try {
    const r = await getQuotes({ range: range.value, accounts: accountIds.value })
    if (id === request) data.value = r
  } catch (e: any) {
    if (id === request) error.value = e?.message ?? 'Kurse konnten nicht geladen werden'
  } finally {
    if (id === request) {
      loading.value = false
      reloading.value = false
    }
  }
}

/** Every depot the caller may read, for the scope selector. */
const accounts = ref<PortfolioAccount[]>([])
async function loadAccounts() {
  try {
    accounts.value = (await getPortfolio({ accounts: accountIds.value })).accounts
  } catch {
    accounts.value = []
  }
}

const POLL_MS = 60_000
let poll: ReturnType<typeof setInterval> | null = null
function startPolling() {
  stopPolling()
  poll = setInterval(() => {
    if (document.visibilityState === 'visible') void load(true)
  }, POLL_MS)
}
function stopPolling() {
  if (poll) clearInterval(poll)
  poll = null
}

onMounted(() => {
  void load()
  void loadAccounts()
  startPolling()
})
onBeforeUnmount(stopPolling)
watch([range, accountIds], () => void load(true))

// ── Refresh now ──────────────────────────────────────────────────────
const refreshing = ref(false)
const refreshNote = ref<string | null>(null)
async function refreshNow() {
  refreshing.value = true
  refreshNote.value = null
  try {
    const stats = await refreshQuotes({ accounts: accountIds.value })
    const parts = [`${stats.fetched} Abruf${stats.fetched === 1 ? '' : 'e'}`, `${stats.points} neue Kurse`]
    if (stats.unresolved > 0) parts.push(`${stats.unresolved} ohne Symbol`)
    if (stats.rate_limited) parts.push('Anbieter bremst — später weiter')
    if (stats.errors.length > 0) parts.push(`${stats.errors.length} Fehler`)
    refreshNote.value = parts.join(' · ')
    await load(true)
  } catch (e: any) {
    refreshNote.value = e?.message ?? 'Abruf fehlgeschlagen'
  } finally {
    refreshing.value = false
  }
}

// ── Toolbar ──────────────────────────────────────────────────────────
const filterPanelOpen = ref(false)
const accountOptions = computed(() =>
  accounts.value.map((a) => ({ label: a.closed ? `${a.label} (geschlossen)` : a.label, value: a.id })),
)
const accountLabelById = computed(() => new Map(accounts.value.map((a) => [a.id, a.label])))
const filterChips = computed<FilterChip[]>(() =>
  accountIds.value.map((id) => ({
    key: `account:${id}`,
    label: accountLabelById.value.get(id) ?? `Depot #${id}`,
    remove: () => setQuery({ accounts: accountIds.value.filter((x) => x !== id).join(',') }),
  })),
)
const accountsModel = computed({
  get: () => accountIds.value,
  set: (ids: number[]) => setQuery({ accounts: ids.join(',') }),
})

const term = computed(() => search.term.value.trim().toLowerCase())
const tiles = computed(() =>
  (data.value?.tiles ?? []).filter(
    (t) =>
      !term.value ||
      (t.name ?? '').toLowerCase().includes(term.value) ||
      (t.isin ?? '').toLowerCase().includes(term.value) ||
      (t.wkn ?? '').toLowerCase().includes(term.value),
  ),
)

const toolbar = useListToolbar({
  search,
  filter: {
    chips: filterChips,
    activeCount: () => filterChips.value.length,
    open: () => { filterPanelOpen.value = !filterPanelOpen.value },
    expanded: filterPanelOpen,
    clearAll: () => setQuery({ accounts: '' }),
  },
  view: rangeView,
  result: {
    loaded: () => tiles.value.length,
    total: () => data.value?.tiles.length ?? 0,
    loading: () => loading.value,
  },
})

// ── Figures ──────────────────────────────────────────────────────────
const total = computed(() => {
  let sum = 0
  let any = false
  for (const t of tiles.value) {
    if (t.value === null) continue
    sum += Number(t.value)
    any = true
  }
  return any ? sum.toFixed(2) : null
})
/** Change of the whole scope over the range: the shares' change, summed. */
const totalChange = computed(() => {
  let sum = 0
  let any = false
  for (const t of tiles.value) {
    if (!t.change) continue
    sum += Number(t.change.absolute) * Number(t.amount)
    any = true
  }
  return any ? sum.toFixed(2) : null
})
const currency = computed(() => tiles.value.find((t) => t.currency)?.currency ?? 'EUR')

const hint = computed(() => {
  const asOf = data.value?.as_of
  return asOf ? `Stand ${formatStamp(asOf)} · etwa 15 Minuten verzögert` : 'Kurse etwa 15 Minuten verzögert'
})

function formatStamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function formatPrice(raw: string, cur: string | null): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 2 }).format(Number(raw))
}
function openPosition(tile: QuoteTile) {
  void router.push({
    name: 'finance-portfolio-position',
    params: { key: tile.key },
    query: accountIds.value.length > 0 ? { accounts: accountIds.value.join(',') } : {},
  })
}

// ── Sparklines ───────────────────────────────────────────────────────
// One series, no axes: the line in the brand hue, the change in the
// text's own gain colour next to it. Colours are read off the theme so
// the chart follows a theme switch.
const isDark = useMediaQuery('(prefers-color-scheme: dark)')
const lineColor = computed(() => {
  void isDark.value
  return getComputedStyle(document.documentElement).getPropertyValue('--p-primary-color').trim() || '#2563eb'
})

function sparkData(tile: QuoteTile) {
  return {
    labels: tile.points.map((p) => p.at),
    datasets: [
      {
        data: tile.points.map((p) => Number(p.price)),
        borderColor: lineColor.value,
        borderWidth: 2,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        pointHitRadius: 10,
        spanGaps: true,
      },
    ],
  }
}

function sparkOptions(tile: QuoteTile) {
  const fmt = (v: number) => formatPrice(String(v), tile.currency)
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        displayColors: false,
        callbacks: {
          title: (ctx: Array<{ label: string }>) => formatStamp(ctx[0]?.label ?? ''),
          label: (ctx: { parsed: { y: number } }) => fmt(ctx.parsed.y),
        },
      },
    },
    scales: {
      x: { display: false },
      y: { display: false },
    },
  }
}

const STATUS_TEXT: Record<QuoteTile['status'], string> = {
  ok: '',
  pending: 'Noch keine Kurse — der nächste Abruf bringt sie',
  unresolved: 'Kein Symbol beim Kursanbieter gefunden',
}
</script>

<template>
  <PageLayout title="Kurse" :hint="hint" width="wide" :ready="!loading">
    <template #actions>
      <Button
        icon="pi pi-refresh"
        text
        rounded
        :loading="refreshing"
        aria-label="Kurse jetzt abrufen"
        v-tooltip.bottom="'Kurse jetzt abrufen'"
        @click="refreshNow"
      />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
      <section v-if="filterPanelOpen" class="qv-filter-panel" aria-label="Filter">
        <MultiSelect
          v-model="accountsModel"
          :options="accountOptions"
          option-label="label"
          option-value="value"
          placeholder="Alle Depots"
          :max-selected-labels="2"
          display="chip"
          aria-label="Depots eingrenzen"
          class="qv-filter-input"
        />
      </section>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load()" @close="error = null" />
      <p v-if="refreshNote" class="qv-note" role="status">{{ refreshNote }}</p>
    </template>

    <PageSkeleton v-if="loading && !data" variant="grid" />

    <EmptyState
      v-else-if="tiles.length === 0"
      icon="pi pi-chart-line"
      title="Keine Wertpapiere"
      :message="term ? 'Kein Wertpapier passt zur Suche.' : 'In den gewählten Depots liegt derzeit nichts.'"
      :filtered="!!term || accountIds.length > 0"
      @clear-filters="search.value.value = ''; setQuery({ accounts: '' })"
    />

    <div v-else class="qv-body" :class="{ 'is-reloading': reloading }">
      <section v-if="total !== null" class="qv-summary" aria-label="Gesamt">
        <span class="qv-summary-label">Wert der Positionen</span>
        <span class="qv-summary-value">{{ formatCurrency(total, currency) }}</span>
        <span v-if="totalChange !== null" class="qv-summary-delta" :class="`gain-${gainSign(totalChange)}`">
          {{ formatSignedCurrency(totalChange, currency) }} {{ RANGE_TEXT[range] }}
        </span>
      </section>

      <ul class="qv-grid" aria-label="Wertpapiere">
        <li v-for="tile in tiles" :key="tile.key">
          <article class="qv-tile" :class="{ 'is-empty': tile.status !== 'ok' }">
            <button type="button" class="qv-tile-head" @click="openPosition(tile)">
              <span class="qv-tile-name">{{ tile.name ?? tile.key }}</span>
              <span class="qv-tile-id">{{ tile.isin ?? tile.wkn }}</span>
            </button>

            <template v-if="tile.last">
              <div class="qv-tile-figures">
                <span class="qv-tile-price">{{ formatPrice(tile.last.price, tile.currency) }}</span>
                <span v-if="tile.change" class="qv-tile-change" :class="`gain-${gainSign(tile.change.absolute)}`">
                  {{ formatSignedPercent(tile.change.percent) }}
                  <span class="qv-tile-change-abs">{{ formatSignedCurrency(tile.change.absolute, tile.currency) }}</span>
                </span>
                <span v-else class="qv-tile-change qv-muted">{{ RANGE_TEXT[range] }}: –</span>
              </div>
              <div class="qv-spark" :class="{ 'is-flat': tile.points.length < 2 }">
                <Chart v-if="tile.points.length >= 2" type="line" :data="sparkData(tile)" :options="sparkOptions(tile)" class="qv-spark-chart" />
                <span v-else class="qv-muted">Für diesen Zeitraum liegen noch keine Kurse vor.</span>
              </div>
              <dl class="qv-tile-foot">
                <div>
                  <dt>Bestand</dt>
                  <dd>{{ formatQuantity(tile.amount) }} Stk</dd>
                </div>
                <div>
                  <dt>Wert</dt>
                  <dd>{{ formatCurrency(tile.value, tile.currency) }}</dd>
                </div>
                <div>
                  <dt>Stand</dt>
                  <dd>{{ formatStamp(tile.last.at) }}</dd>
                </div>
              </dl>
            </template>
            <p v-else class="qv-tile-status qv-muted">
              <i class="pi pi-info-circle" aria-hidden="true" /> {{ STATUS_TEXT[tile.status] }}
            </p>
          </article>
        </li>
      </ul>
    </div>
  </PageLayout>
</template>

<style scoped>
.qv-filter-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}
.qv-filter-input {
  width: 100%;
  min-width: 0;
}
.qv-note {
  margin: 0;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

.qv-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  transition: opacity 150ms ease;
}
.qv-body.is-reloading {
  opacity: 0.6;
}

.qv-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
}
.qv-summary-label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.qv-summary-value {
  font-size: var(--text-3xl);
  font-weight: 600;
  color: var(--p-text-color);
}
.qv-summary-delta {
  font-size: var(--text-base);
}

.qv-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: var(--space-3);
}

.qv-tile {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  height: 100%;
  padding: var(--space-3);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.75rem;
}
.qv-tile.is-empty {
  color: var(--p-text-muted-color);
}

.qv-tile-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  color: inherit;
  cursor: pointer;
  border-radius: 0.25rem;
}
.qv-tile-head:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.qv-tile-head:hover .qv-tile-name {
  text-decoration: underline;
}
.qv-tile-name {
  font-weight: 600;
  color: var(--p-text-color);
  overflow-wrap: anywhere;
}
.qv-tile-id {
  font-size: var(--text-xs);
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}

.qv-tile-figures {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
}
.qv-tile-price {
  font-size: var(--text-2xl);
  font-weight: 600;
  color: var(--p-text-color);
  font-variant-numeric: tabular-nums;
}
.qv-tile-change {
  display: inline-flex;
  gap: 0.4rem;
  align-items: baseline;
  font-size: var(--text-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.qv-tile-change-abs {
  font-weight: 400;
}

.qv-spark {
  position: relative;
  height: 4.5rem;
  /* The ring of a focused tooltip target is drawn inside the tile. */
  padding: var(--focus-ring-reach);
  margin: calc(-1 * var(--focus-ring-reach));
}
.qv-spark.is-flat {
  display: flex;
  align-items: center;
  font-size: var(--text-sm);
}
.qv-spark-chart {
  width: 100%;
  height: 100%;
}

.qv-tile-foot {
  display: grid;
  grid-template-columns: repeat(3, auto);
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-xs);
}
.qv-tile-foot div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.qv-tile-foot dt {
  color: var(--p-text-muted-color);
}
.qv-tile-foot dd {
  margin: 0;
  color: var(--p-text-color);
  font-variant-numeric: tabular-nums;
}

.qv-tile-status {
  margin: 0;
  font-size: var(--text-sm);
}
.qv-muted {
  color: var(--p-text-muted-color);
}

.gain-pos {
  color: var(--p-green-600);
}
.gain-neg {
  color: var(--p-red-600);
}
.gain-flat {
  color: var(--p-text-muted-color);
}
</style>
