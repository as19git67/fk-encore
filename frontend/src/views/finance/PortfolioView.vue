<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import MultiSelect from 'primevue/multiselect'
import Select from 'primevue/select'
import PageLayout from '../../components/layout/PageLayout.vue'
import ListToolbar from '../../components/layout/ListToolbar.vue'
import ScrollX from '../../components/layout/ScrollX.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import DepotTxSources from '../../components/finance/DepotTxSources.vue'
import PortfolioReview from '../../components/finance/PortfolioReview.vue'
import { useListSearch, useListToolbar } from '../../composables/useListToolbar'
import { useSort } from '../../composables/useSort'
import type { FilterChip } from '../../components/layout/listToolbar'
import { replaceQuerySlice, updateRouteQuery } from '../../utils/routeQueryUpdate'
import {
  enrichDepotTransactionsFromDocuments,
  getPortfolio,
  resetDocumentReadings,
  listPortfolioTransactions,
  type PortfolioPosition,
  type PortfolioResponse,
  type PortfolioTransaction,
  type PortfolioTxSortField,
} from '../../api/finance'
import {
  DEPOT_KIND_LABELS,
  depotKindLabel,
  formatCurrency,
  formatIsoDate,
  formatPercent,
  formatQuantity,
  formatSignedCurrency,
  formatSignedPercent,
  gainSign,
} from '../../utils/financeFormat'

/**
 * Portfolio — every security across the depots the user may read
 * (issue #1336, stages 1–2): key figures, one row per position, the
 * yearly realized / income / cost figures, and the transaction list.
 *
 * Scope and filters live in the URL (`accounts`, `position`, `kind`,
 * `year`, `q`, `sortBy`/`sortDir`, `closed`), so a reload or a shared
 * link shows the same page. The scope narrows everything; the search
 * narrows positions in place and the transactions on the server; kind
 * and year only narrow the transactions.
 */

const route = useRoute()
const router = useRouter()

// ── URL-backed filters ───────────────────────────────────────────────
const FILTER_KEYS = ['accounts', 'position', 'kind', 'year', 'closed', 'closedDepots'] as const

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
const positionFilter = computed(() => queryString('position'))
const kindFilter = computed(() => queryString('kind'))
const yearFilter = computed(() => {
  const n = Number(queryString('year'))
  return Number.isInteger(n) && n > 0 ? n : null
})
const showClosed = computed(() => queryString('closed') === '1')
/** Closed depots (sold out, moved away) are left out unless switched on. */
const includeClosedDepots = computed(() => queryString('closedDepots') === '1')

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

const search = useListSearch({
  placeholder: 'Wertpapier, ISIN oder WKN',
  storageKey: 'finance.portfolio.search',
})

const sort = useSort({
  fields: [
    { value: 'executed_at', label: 'Datum' },
    { value: 'net_amount', label: 'Betrag' },
    { value: 'name', label: 'Wertpapier' },
  ],
  defaultState: { field: 'executed_at', direction: 'desc' },
})

// ── Portfolio (summary, positions, years) ────────────────────────────
const portfolio = ref<PortfolioResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function loadPortfolio() {
  loading.value = true
  error.value = null
  try {
    portfolio.value = await getPortfolio({ accounts: accountIds.value, closed: includeClosedDepots.value })
  } catch (e: any) {
    error.value = e?.message ?? 'Portfolio konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

const currency = computed(() => portfolio.value?.currency ?? 'EUR')
const summary = computed(() => portfolio.value?.summary ?? null)

const accountOptions = computed(() =>
  (portfolio.value?.accounts ?? []).map((a) => ({
    label: a.closed ? `${a.label} (geschlossen)` : a.label,
    value: a.id,
  })),
)
const accountLabelById = computed(() => {
  const m = new Map<number, string>()
  for (const a of portfolio.value?.accounts ?? []) m.set(a.id, a.label)
  return m
})

const term = computed(() => search.term.value.trim().toLowerCase())

function matchesTerm(p: PortfolioPosition): boolean {
  if (!term.value) return true
  return (
    (p.name ?? '').toLowerCase().includes(term.value) ||
    (p.isin ?? '').toLowerCase().includes(term.value) ||
    (p.wkn ?? '').toLowerCase().includes(term.value)
  )
}

const openPositions = computed(() =>
  (portfolio.value?.positions ?? []).filter((p) => p.open && matchesTerm(p)),
)
const closedPositions = computed(() =>
  (portfolio.value?.positions ?? []).filter((p) => !p.open && matchesTerm(p)),
)
const visiblePositions = computed(() =>
  showClosed.value ? [...openPositions.value, ...closedPositions.value] : openPositions.value,
)

const positionOptions = computed(() =>
  (portfolio.value?.positions ?? []).map((p) => ({
    label: p.name ?? p.key,
    value: p.key,
  })),
)
const positionLabel = computed(() => {
  const key = positionFilter.value
  if (!key) return ''
  return portfolio.value?.positions.find((p) => p.key === key)?.name ?? key
})

const yearOptions = computed(() =>
  (portfolio.value?.years ?? []).map((y) => ({ label: String(y.year), value: y.year })),
)
const kindOptions = Object.entries(DEPOT_KIND_LABELS).map(([value, label]) => ({ value, label }))

// Which optional columns carry data at all — a wall of dashes helps nobody.
const showCostColumn = computed(() => visiblePositions.value.some((p) => p.cost_basis !== null))
const showRealizedColumn = computed(() =>
  visiblePositions.value.some((p) => p.realized_gain !== null),
)
const showIncomeColumn = computed(() => visiblePositions.value.some((p) => p.income !== null))

function openPosition(key: string) {
  void router.push({
    name: 'finance-portfolio-position',
    params: { key },
    query: {
      ...(accountIds.value.length > 0 ? { accounts: accountIds.value.join(',') } : {}),
      ...(includeClosedDepots.value ? { closedDepots: '1' } : {}),
    },
  })
}

// ── Transactions ─────────────────────────────────────────────────────
const PAGE_SIZE = 100
const transactions = ref<PortfolioTransaction[]>([])
const txTotal = ref(0)
const txSums = ref<{ net_amount: string; fees: string; taxes: string } | null>(null)
const txLoading = ref(false)
const txError = ref<string | null>(null)
let txRequest = 0

function txParams(offset: number) {
  const year = yearFilter.value
  return {
    accounts: accountIds.value,
    closed: includeClosedDepots.value,
    position: positionFilter.value || undefined,
    kind: kindFilter.value || undefined,
    q: search.term.value.trim() || undefined,
    from: year ? `${year}-01-01` : undefined,
    to: year ? `${year}-12-31` : undefined,
    sortBy: sort.applied.value.field as PortfolioTxSortField,
    sortDir: sort.applied.value.direction,
    limit: PAGE_SIZE,
    offset,
  }
}

async function loadTransactions(append = false) {
  const requestId = ++txRequest
  txLoading.value = true
  txError.value = null
  try {
    const offset = append ? transactions.value.length : 0
    const res = await listPortfolioTransactions(txParams(offset))
    if (requestId !== txRequest) return
    transactions.value = append ? [...transactions.value, ...res.items] : res.items
    txTotal.value = res.total
    txSums.value = res.sums
  } catch (e: any) {
    if (requestId !== txRequest) return
    txError.value = e?.message ?? 'Transaktionen konnten nicht geladen werden'
  } finally {
    if (requestId === txRequest) txLoading.value = false
  }
}

const hasMore = computed(() => transactions.value.length < txTotal.value)

onMounted(() => {
  void loadPortfolio()
  void loadTransactions()
})

watch(
  () => `${accountIds.value.join(',')}|${includeClosedDepots.value}`,
  () => void loadPortfolio(),
)

watch(
  () => [
    accountIds.value.join(','),
    includeClosedDepots.value,
    positionFilter.value,
    kindFilter.value,
    yearFilter.value,
    search.term.value,
    sort.applied.value.field,
    sort.applied.value.direction,
  ],
  () => void loadTransactions(),
)

// ── Toolbar ──────────────────────────────────────────────────────────
const filterPanelOpen = ref(false)

function clearFilters() {
  setQuery({ accounts: '', position: '', kind: '', year: '', closedDepots: '' })
}

const filterChips = computed<FilterChip[]>(() => {
  const chips: FilterChip[] = []
  if (accountIds.value.length > 0) {
    const labels = accountIds.value.map((id) => accountLabelById.value.get(id) ?? `#${id}`)
    chips.push({
      key: 'accounts',
      label: `Depot: ${labels.join(', ')}`,
      remove: () => setQuery({ accounts: '' }),
    })
  }
  if (positionFilter.value) {
    chips.push({
      key: 'position',
      label: `Position: ${positionLabel.value}`,
      remove: () => setQuery({ position: '' }),
    })
  }
  if (kindFilter.value) {
    chips.push({
      key: 'kind',
      label: `Art: ${depotKindLabel(kindFilter.value)}`,
      remove: () => setQuery({ kind: '' }),
    })
  }
  if (yearFilter.value) {
    chips.push({
      key: 'year',
      label: `Jahr: ${yearFilter.value}`,
      remove: () => setQuery({ year: '' }),
    })
  }
  if (includeClosedDepots.value) {
    chips.push({
      key: 'closedDepots',
      label: 'Mit geschlossenen Depots',
      remove: () => setQuery({ closedDepots: '' }),
    })
  }
  return chips
})

const toolbar = useListToolbar({
  search,
  filter: {
    chips: filterChips,
    activeCount: () => filterChips.value.length,
    open: () => { filterPanelOpen.value = !filterPanelOpen.value },
    expanded: filterPanelOpen,
    clearAll: clearFilters,
  },
  sort,
  result: {
    loaded: () => transactions.value.length,
    total: () => txTotal.value,
    loading: () => txLoading.value,
  },
})

// v-model bridges for the filter panel: the controls edit the URL directly.
const accountsModel = computed({
  get: () => accountIds.value,
  set: (ids: number[]) => setQuery({ accounts: ids.join(',') }),
})
const positionModel = computed({
  get: () => positionFilter.value || null,
  set: (key: string | null) => setQuery({ position: key ?? '' }),
})
const kindModel = computed({
  get: () => kindFilter.value || null,
  set: (kind: string | null) => setQuery({ kind: kind ?? '' }),
})
const yearModel = computed({
  get: () => yearFilter.value,
  set: (year: number | null) => setQuery({ year: year ? String(year) : '' }),
})
const closedModel = computed({
  get: () => showClosed.value,
  set: (v: boolean) => setQuery({ closed: v ? '1' : '' }),
})
const closedDepotsModel = computed({
  get: () => includeClosedDepots.value,
  set: (v: boolean) => setQuery({ closedDepots: v ? '1' : '' }),
})

// ── Presentation ─────────────────────────────────────────────────────
const hint = computed(() => {
  if (!portfolio.value) return undefined
  const all = portfolio.value.accounts
  const open = all.filter((a) => !a.closed).length
  const scope =
    accountIds.value.length > 0 ? accountIds.value.length : includeClosedDepots.value ? all.length : open
  const total = includeClosedDepots.value || accountIds.value.length > 0 ? all.length : open
  const parts = [`${scope} von ${total} Depot${total === 1 ? '' : 's'}`]
  if (portfolio.value.closed_hidden > 0) {
    parts.push(`${portfolio.value.closed_hidden} geschlossene ausgeblendet`)
  }
  if (summary.value?.as_of) parts.push(`Stand ${formatIsoDate(summary.value.as_of)}`)
  if (portfolio.value.mixed_currency) parts.push('gemischte Währungen — Summen nominal')
  return parts.join(' · ')
})

const noDepots = computed(() => !!portfolio.value && portfolio.value.accounts.length === 0)

const positionsEmptyMessage = computed(() => {
  if (term.value) return 'Kein Wertpapier passt zum Suchbegriff.'
  if (closedPositions.value.length > 0 && !showClosed.value) {
    return 'Alle Positionen sind geschlossen — „Geschlossene anzeigen" blendet sie ein.'
  }
  return 'Sobald ein Depot Bestände meldet, erscheinen sie hier.'
})

function isSignedCell(val: string | null): string {
  return `gain-${gainSign(val)}`
}

function transactionCash(tx: PortfolioTransaction): string {
  if (tx.net_amount !== null) return formatSignedCurrency(tx.net_amount, tx.currency)
  if (tx.gross_amount !== null) return formatCurrency(tx.gross_amount, tx.currency)
  return '–'
}

// ── Settlement documents (#1336, stage 4) ────────────────────────────
// Documents are read after classification on their own; this runs the
// same over every settlement not linked yet — old statements, or ones
// that arrived before the depot's holdings told them where they belong.
const enriching = ref(false)
/** Bumped to make the review section reload (after reading documents). */
const reviewReloadKey = ref(0)

function onReviewChanged() {
  void loadPortfolio()
  void loadTransactions()
}
const enrichNotice = ref<{ severity: 'success' | 'info' | 'warn'; text: string } | null>(null)
/** Documents examined so far in the running read, shown on the button. */
const enrichProgress = ref(0)

const COUNTED = ['documents_examined', 'created', 'enriched', 'linked', 'conflicts', 'unverified', 'skipped_no_holding', 'skipped_no_transaction'] as const
type EnrichTotals = Record<(typeof COUNTED)[number], number>

const confirm = useConfirm()

/** Take back what documents booked into the depots in scope, then read them all in again. */
function askReadAgain() {
  confirm.require({
    header: 'Belege neu einlesen',
    message:
      'Alle Transaktionen, die aus Belegen angelegt oder ergänzt wurden, werden gelöscht; aus Kontobuchungen ' +
      'abgeleitete werden danach neu abgeleitet. Manuell erfasste Transaktionen bleiben, nur ihre Verknüpfung ' +
      'zu Belegen wird gelöst. Die gespeicherten KI-Antworten werden verworfen, damit die KI jeden Beleg neu liest — ' +
      'das dauert länger. „Für Depots ignorieren“ bleibt erhalten.',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Löschen und neu einlesen', severity: 'danger' },
    accept: () => { void readAgain() },
  })
}

async function readAgain() {
  enriching.value = true
  enrichNotice.value = null
  try {
    await resetDocumentReadings(accountIds.value)
  } catch (e: any) {
    enrichNotice.value = { severity: 'warn', text: e?.message ?? 'Belege konnten nicht zurückgesetzt werden' }
    enriching.value = false
    return
  }
  await Promise.all([loadPortfolio(), loadTransactions()])
  await enrichFromDocuments()
}

async function enrichFromDocuments() {
  enriching.value = true
  enrichNotice.value = null
  enrichProgress.value = 0
  try {
    // The server reads one page per call, newest first; keep going until it
    // says there is nothing left, so years of statements are all read.
    const r: EnrichTotals = Object.fromEntries(COUNTED.map((k) => [k, 0])) as EnrichTotals
    let before: number | null = null
    do {
      const page = await enrichDepotTransactionsFromDocuments({ accounts: accountIds.value, before })
      for (const k of COUNTED) r[k] += page[k] ?? 0
      enrichProgress.value = r.documents_examined
      before = page.next_before ?? null
    } while (before !== null)
    const changed = r.created + r.enriched + r.linked
    const parts: string[] = []
    if (r.created > 0) parts.push(`${r.created} neu angelegt`)
    if (r.enriched > 0) parts.push(`${r.enriched} ergänzt`)
    if (r.linked > 0) parts.push(`${r.linked} verknüpft`)
    if (r.conflicts > 0) parts.push(`${r.conflicts} mit abweichendem Betrag — bitte prüfen`)
    if (r.unverified > 0) parts.push(`${r.unverified} unsicher erkannt — bitte prüfen`)
    if (r.skipped_no_holding > 0) parts.push(`${r.skipped_no_holding} ohne passendes Depot`)
    if (r.skipped_no_transaction > 0) parts.push(`${r.skipped_no_transaction} Steuermitteilungen ohne passende Transaktion`)
    enrichNotice.value = {
      severity: r.conflicts > 0 || r.unverified > 0 ? 'warn' : changed > 0 ? 'success' : 'info',
      text: parts.length > 0
        ? `Belege eingelesen: ${parts.join(', ')}.`
        : 'Keine neuen Wertpapier- oder Dividendenabrechnungen gefunden.',
    }
    if (changed > 0) {
      await Promise.all([loadPortfolio(), loadTransactions()])
    }
    reviewReloadKey.value++
  } catch (e: any) {
    enrichNotice.value = { severity: 'warn', text: e?.message ?? 'Belege konnten nicht eingelesen werden' }
  } finally {
    enriching.value = false
    enrichProgress.value = 0
  }
}
</script>

<template>
  <PageLayout title="Portfolio" :hint="hint" width="wide" :ready="!loading">
    <template #actions>
      <Button
        icon="pi pi-refresh"
        label="Aktualisieren"
        severity="secondary"
        text
        :disabled="loading || txLoading"
        @click="loadPortfolio(); loadTransactions()"
      />
      <Button
        v-tooltip.bottom="'Wertpapier- und Dividendenabrechnungen aus den Dokumenten lesen und den Transaktionen zuordnen'"
        icon="pi pi-file-import"
        :label="enriching && enrichProgress > 0 ? `Belege einlesen … ${enrichProgress} geprüft` : 'Belege einlesen'"
        severity="secondary"
        text
        :loading="enriching"
        :disabled="noDepots"
        @click="enrichFromDocuments"
      />
      <Button
        v-tooltip.bottom="'Alles, was Belege gebucht haben, zurücknehmen und alle Belege neu lesen'"
        icon="pi pi-history"
        aria-label="Belege neu einlesen"
        severity="secondary"
        text
        :disabled="noDepots || enriching"
        @click="askReadAgain"
      />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
      <section v-if="filterPanelOpen" class="pf-filter-panel" aria-label="Filter">
        <label v-if="accountOptions.some((o) => o.label.endsWith('(geschlossen)'))" class="pf-filter-check">
          <Checkbox v-model="closedDepotsModel" binary input-id="pf-closed-depots" />
          <span>Geschlossene Depots einbeziehen</span>
        </label>
        <MultiSelect
          v-model="accountsModel"
          :options="accountOptions"
          option-label="label"
          option-value="value"
          placeholder="Alle Depots"
          :max-selected-labels="2"
          display="chip"
          aria-label="Depots eingrenzen"
          class="pf-filter-input"
        />
        <Select
          v-model="positionModel"
          :options="positionOptions"
          option-label="label"
          option-value="value"
          placeholder="Alle Wertpapiere"
          show-clear
          filter
          aria-label="Wertpapier eingrenzen"
          class="pf-filter-input"
        />
        <Select
          v-model="kindModel"
          :options="kindOptions"
          option-label="label"
          option-value="value"
          placeholder="Alle Arten"
          show-clear
          aria-label="Art der Transaktion"
          class="pf-filter-input"
        />
        <Select
          v-model="yearModel"
          :options="yearOptions"
          option-label="label"
          option-value="value"
          placeholder="Alle Jahre"
          show-clear
          aria-label="Jahr"
          class="pf-filter-input"
        />
      </section>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="loadPortfolio" @close="error = null" />
      <Message
        v-if="enrichNotice"
        :severity="enrichNotice.severity"
        closable
        @close="enrichNotice = null"
      >{{ enrichNotice.text }}</Message>
    </template>

    <PageSkeleton v-if="loading && !portfolio" variant="list" :count="6" />

    <EmptyState
      v-else-if="noDepots"
      icon="pi pi-briefcase"
      title="Kein Depot"
      message="Lege unter Konten ein Depotkonto an oder lass dir Zugriff auf eines geben — dann erscheinen hier seine Wertpapiere."
    />

    <template v-else-if="portfolio && summary">
      <!-- ── Key figures ──────────────────────────────────────────── -->
      <section class="pf-section" aria-labelledby="pf-kpi-heading">
        <h2 id="pf-kpi-heading" class="visually-hidden">Kennzahlen</h2>
        <div class="pf-kpis">
          <div class="pf-kpi">
            <span class="pf-kpi-label">Depotwert</span>
            <span class="pf-kpi-value">{{ formatCurrency(summary.market_value, currency) }}</span>
            <span class="pf-kpi-sub">{{ summary.open_positions }} offene Position{{ summary.open_positions === 1 ? '' : 'en' }}</span>
          </div>
          <div class="pf-kpi">
            <span class="pf-kpi-label">Einstand</span>
            <span class="pf-kpi-value">{{ formatCurrency(summary.cost_basis, currency) }}</span>
            <span v-if="!summary.cost_basis_complete" class="pf-kpi-sub pf-kpi-warn">
              <i class="pi pi-exclamation-triangle" aria-hidden="true" /> nicht für jede Position bekannt
            </span>
          </div>
          <div class="pf-kpi">
            <span class="pf-kpi-label">Unrealisiert</span>
            <span class="pf-kpi-value" :class="isSignedCell(summary.unrealized_gain)">
              {{ formatSignedCurrency(summary.unrealized_gain, currency) }}
            </span>
            <span class="pf-kpi-sub">{{ formatSignedPercent(summary.unrealized_gain_pct) }}</span>
          </div>
          <div class="pf-kpi">
            <span class="pf-kpi-label">Realisiert</span>
            <span class="pf-kpi-value" :class="isSignedCell(summary.realized_gain)">
              {{ formatSignedCurrency(summary.realized_gain, currency) }}
            </span>
            <span class="pf-kpi-sub">
              {{ formatSignedCurrency(summary.realized_gain_ytd, currency) }} dieses Jahr
              <i
                v-if="!summary.realized_gain_complete"
                class="pi pi-exclamation-triangle pf-kpi-warn"
                title="Nicht jeder Kauf oder Verkauf trägt Stückzahl und Kurs — der Wert ist unvollständig"
                aria-label="Unvollständig"
              />
            </span>
          </div>
          <div class="pf-kpi">
            <span class="pf-kpi-label">Erträge</span>
            <span class="pf-kpi-value" :class="isSignedCell(summary.income)">
              {{ formatSignedCurrency(summary.income, currency) }}
            </span>
            <span class="pf-kpi-sub">{{ formatSignedCurrency(summary.income_ytd, currency) }} dieses Jahr</span>
          </div>
          <div class="pf-kpi">
            <span class="pf-kpi-label">Gebühren · Steuern</span>
            <span class="pf-kpi-value">{{ formatCurrency(summary.fees, currency) }}</span>
            <span class="pf-kpi-sub">Steuern {{ formatCurrency(summary.taxes, currency) }}</span>
          </div>
          <div class="pf-kpi pf-kpi-total">
            <span class="pf-kpi-label">Gesamtrendite</span>
            <span class="pf-kpi-value" :class="isSignedCell(summary.total_return)">
              {{ formatSignedCurrency(summary.total_return, currency) }}
            </span>
            <span class="pf-kpi-sub">{{ formatSignedPercent(summary.total_return_pct) }} · unrealisiert + realisiert + Erträge</span>
          </div>
        </div>
        <p class="pf-method">
          Einstand: Einstandskurs der Bank, sonst gewichteter Durchschnitt der Käufe (∅).
          Realisierte Gewinne nach Durchschnittsmethode, Erlöse und Erträge netto nach Gebühren und Steuern.
        </p>
      </section>

      <PortfolioReview
        :accounts="accountIds"
        :include-closed="includeClosedDepots"
        :currency="currency"
        :reload-key="reviewReloadKey"
        @changed="onReviewChanged"
      />

      <!-- ── Positions ────────────────────────────────────────────── -->
      <section class="pf-section" aria-labelledby="pf-positions-heading">
        <div class="pf-section-head">
          <h2 id="pf-positions-heading">Positionen</h2>
          <label v-if="closedPositions.length > 0" class="pf-closed-toggle">
            <Checkbox v-model="closedModel" binary input-id="pf-show-closed" />
            <span>Geschlossene anzeigen ({{ closedPositions.length }})</span>
          </label>
        </div>

        <EmptyState
          v-if="visiblePositions.length === 0"
          icon="pi pi-briefcase"
          title="Keine Positionen"
          :message="positionsEmptyMessage"
        />

        <ScrollX v-else>
          <table class="pf-table pf-positions">
            <thead>
              <tr>
                <th class="pf-col-name">Wertpapier</th>
                <th class="pf-col-num">Stück</th>
                <th class="pf-col-num">Kurs</th>
                <th class="pf-col-num">Wert</th>
                <th class="pf-col-num">Anteil</th>
                <th v-if="showCostColumn" class="pf-col-num">Einstand</th>
                <th v-if="showCostColumn" class="pf-col-num">Unrealisiert</th>
                <th v-if="showRealizedColumn" class="pf-col-num">Realisiert</th>
                <th v-if="showIncomeColumn" class="pf-col-num">Erträge</th>
                <th class="pf-col-num">Gesamt</th>
                <th class="pf-col-depots">Depot</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in visiblePositions"
                :key="p.key"
                class="pf-row"
                :class="{ 'pf-row-active': positionFilter === p.key, 'pf-row-closed': !p.open }"
                tabindex="0"
                role="link"
                :aria-label="`${p.name ?? p.key} öffnen`"
                @click="openPosition(p.key)"
                @keydown.enter.prevent="openPosition(p.key)"
                @keydown.space.prevent="openPosition(p.key)"
              >
                <td class="pf-col-name">
                  <span class="pf-name">{{ p.name ?? p.key }}</span>
                  <span class="pf-ident">
                    {{ p.isin ?? p.wkn ?? '' }}<template v-if="!p.open"> · geschlossen</template>
                  </span>
                </td>
                <td class="pf-col-num">{{ formatQuantity(p.amount) }}</td>
                <td class="pf-col-num">
                  {{ formatCurrency(p.price, p.currency) }}
                  <span v-if="p.price_as_of && p.price_as_of !== summary.as_of" class="pf-stale" :title="`Kurs vom ${formatIsoDate(p.price_as_of)}`">
                    {{ formatIsoDate(p.price_as_of) }}
                  </span>
                </td>
                <td class="pf-col-num pf-value">{{ formatCurrency(p.value, p.currency) }}</td>
                <td class="pf-col-num">{{ formatPercent(p.weight_pct) }}</td>
                <td v-if="showCostColumn" class="pf-col-num">
                  {{ formatCurrency(p.cost_basis, p.currency) }}
                  <span
                    v-if="p.cost_basis_source === 'tx-wac'"
                    class="pf-cost-source"
                    title="Aus Käufen berechnet (gewichteter Durchschnitt) — die Bank liefert keinen Einstandskurs"
                  >∅</span>
                </td>
                <td v-if="showCostColumn" class="pf-col-num" :class="isSignedCell(p.unrealized_gain)">
                  <span>{{ formatSignedCurrency(p.unrealized_gain, p.currency) }}</span>
                  <span v-if="p.unrealized_gain_pct !== null" class="pf-pct">{{ formatSignedPercent(p.unrealized_gain_pct) }}</span>
                </td>
                <td v-if="showRealizedColumn" class="pf-col-num" :class="isSignedCell(p.realized_gain)">
                  {{ formatSignedCurrency(p.realized_gain, p.currency) }}
                  <i
                    v-if="p.realized_gain !== null && !p.realized_gain_complete"
                    class="pi pi-exclamation-triangle pf-warn"
                    title="Unvollständig — nicht jeder Kauf oder Verkauf trägt Stückzahl und Kurs"
                    aria-label="Unvollständig"
                  />
                </td>
                <td v-if="showIncomeColumn" class="pf-col-num" :class="isSignedCell(p.income)">
                  <span>{{ formatSignedCurrency(p.income, p.currency) }}</span>
                  <span v-if="p.yield_on_cost_pct !== null" class="pf-pct">{{ formatPercent(p.yield_on_cost_pct, 2) }} p. a. auf Einstand</span>
                </td>
                <td class="pf-col-num" :class="isSignedCell(p.total_return)">
                  <span>{{ formatSignedCurrency(p.total_return, p.currency) }}</span>
                  <span v-if="p.total_return_pct !== null" class="pf-pct">{{ formatSignedPercent(p.total_return_pct) }}</span>
                </td>
                <td class="pf-col-depots">
                  {{ p.account_ids.map((id) => accountLabelById.get(id) ?? `#${id}`).join(', ') }}
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <!-- ── Per year ─────────────────────────────────────────────── -->
      <section v-if="portfolio.years.length > 0" class="pf-section" aria-labelledby="pf-years-heading">
        <h2 id="pf-years-heading">Pro Jahr</h2>
        <ScrollX>
          <table class="pf-table pf-years">
            <thead>
              <tr>
                <th>Jahr</th>
                <th class="pf-col-num">Realisiert</th>
                <th class="pf-col-num">Verkäufe</th>
                <th class="pf-col-num">Erträge</th>
                <th class="pf-col-num">Ausschüttungen</th>
                <th class="pf-col-num">Gebühren</th>
                <th class="pf-col-num">Steuern</th>
                <th class="pf-col-num">Netto investiert</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="y in portfolio.years"
                :key="y.year"
                class="pf-row"
                :class="{ 'pf-row-active': yearFilter === y.year }"
                tabindex="0"
                role="button"
                :aria-pressed="yearFilter === y.year"
                :aria-label="`Transaktionen ${y.year} ${yearFilter === y.year ? 'wieder alle zeigen' : 'anzeigen'}`"
                @click="setQuery({ year: yearFilter === y.year ? '' : String(y.year) })"
                @keydown.enter.prevent="setQuery({ year: yearFilter === y.year ? '' : String(y.year) })"
                @keydown.space.prevent="setQuery({ year: yearFilter === y.year ? '' : String(y.year) })"
              >
                <td>{{ y.year }}</td>
                <td class="pf-col-num" :class="isSignedCell(y.realized)">
                  {{ formatSignedCurrency(y.realized, currency) }}
                  <i
                    v-if="!y.realized_complete"
                    class="pi pi-exclamation-triangle pf-warn"
                    title="Unvollständig — nicht jeder Kauf oder Verkauf trägt Stückzahl und Kurs"
                    aria-label="Unvollständig"
                  />
                </td>
                <td class="pf-col-num">{{ y.sell_count }}</td>
                <td class="pf-col-num" :class="isSignedCell(y.income)">{{ formatSignedCurrency(y.income, currency) }}</td>
                <td class="pf-col-num">{{ y.dividend_count }}</td>
                <td class="pf-col-num">{{ formatCurrency(y.fees, currency) }}</td>
                <td class="pf-col-num">{{ formatCurrency(y.taxes, currency) }}</td>
                <td class="pf-col-num" :class="isSignedCell(y.net_invested)">{{ formatSignedCurrency(y.net_invested, currency) }}</td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <!-- ── Transactions ─────────────────────────────────────────── -->
      <section class="pf-section" aria-labelledby="pf-tx-heading">
        <div class="pf-section-head">
          <h2 id="pf-tx-heading">Transaktionen</h2>
          <span v-if="txSums && txTotal > 0" class="pf-tx-sums">
            Σ {{ formatSignedCurrency(txSums.net_amount, currency) }}
            <template v-if="Number(txSums.fees) > 0"> · Gebühren {{ formatCurrency(txSums.fees, currency) }}</template>
            <template v-if="Number(txSums.taxes) > 0"> · Steuern {{ formatCurrency(txSums.taxes, currency) }}</template>
          </span>
        </div>

        <ErrorBanner v-if="txError" :message="txError" closable @retry="loadTransactions()" @close="txError = null" />

        <PageSkeleton v-if="txLoading && transactions.length === 0" variant="list" :count="4" />

        <EmptyState
          v-else-if="transactions.length === 0"
          icon="pi pi-list"
          title="Keine Transaktionen"
          :message="filterChips.length > 0 || term
            ? 'Mit anderen Filtern findet sich vielleicht etwas.'
            : 'Käufe, Verkäufe und Dividenden erscheinen hier, sobald ein Depot sie liefert oder sie aus Girobuchungen abgeleitet wurden.'"
          :filtered="filterChips.length > 0 || !!term"
          @clear-filters="clearFilters(); search.clear()"
        />

        <ScrollX v-else>
          <table class="pf-table pf-transactions">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Art</th>
                <th class="pf-col-name">Wertpapier</th>
                <th class="pf-col-num">Stück</th>
                <th class="pf-col-num">Kurs</th>
                <th class="pf-col-num">Gebühren</th>
                <th class="pf-col-num">Steuern</th>
                <th class="pf-col-num">Betrag</th>
                <th>Depot</th>
                <th>Quelle</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="tx in transactions" :key="tx.id" :class="`pf-tx-${tx.kind}`">
                <td class="pf-date">{{ formatIsoDate(tx.executed_at) }}</td>
                <td><span class="pf-kind" :class="`pf-kind-${tx.kind}`">{{ depotKindLabel(tx.kind) }}</span></td>
                <td class="pf-col-name">
                  <RouterLink
                    class="pf-name pf-name-link"
                    :to="{
                      name: 'finance-portfolio-position',
                      params: { key: tx.position_key },
                      query: includeClosedDepots ? { closedDepots: '1' } : {},
                    }"
                  >{{ tx.name ?? tx.position_key }}</RouterLink>
                  <span class="pf-ident">{{ tx.isin ?? tx.wkn ?? '' }}</span>
                </td>
                <td class="pf-col-num">{{ formatQuantity(tx.amount) }}</td>
                <td class="pf-col-num">{{ formatCurrency(tx.price, tx.currency) }}</td>
                <td class="pf-col-num">{{ formatCurrency(tx.fees, tx.currency) }}</td>
                <td class="pf-col-num">{{ formatCurrency(tx.tax, tx.currency) }}</td>
                <td class="pf-col-num pf-value" :class="isSignedCell(tx.net_amount)">{{ transactionCash(tx) }}</td>
                <td>{{ tx.account_label }}</td>
                <td class="pf-source">
                  <DepotTxSources
                    :source="tx.source"
                    :linked-transaction-id="tx.linked_transaction_id"
                    :document-ids="tx.document_ids"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>

        <div v-if="hasMore" class="pf-more">
          <Button
            label="Mehr laden"
            icon="pi pi-chevron-down"
            severity="secondary"
            text
            :loading="txLoading"
            @click="loadTransactions(true)"
          />
        </div>
      </section>
    </template>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.pf-filter-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
}
.pf-filter-check {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  cursor: pointer;
}
.pf-filter-input {
  width: 100%;
  min-width: 0;
}

.pf-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pf-section h2 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--p-text-color);
}
.pf-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* ── Key figures ───────────────────────────────────────────────────── */
.pf-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-2);
}
.pf-kpi {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: var(--space-2) var(--space-3);
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  min-width: 0;
}
.pf-kpi-total {
  border-color: var(--p-primary-color);
}
.pf-kpi-label {
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--p-text-muted-color);
}
.pf-kpi-value {
  font-size: var(--text-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.pf-kpi-sub {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pf-kpi-warn,
.pf-warn {
  color: var(--p-yellow-500);
}
.pf-method {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

/* ── Tables ────────────────────────────────────────────────────────── */
.pf-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-base);
}
.pf-table th {
  text-align: left;
  font-weight: 600;
  padding: 0.4rem 0.6rem;
  border-bottom: 2px solid var(--p-content-border-color);
  white-space: nowrap;
}
.pf-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
  white-space: nowrap;
}
.pf-col-num {
  text-align: right !important;
  font-variant-numeric: tabular-nums;
}
.pf-col-num > span {
  display: block;
}
.pf-pct {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pf-col-name {
  white-space: normal !important;
  min-width: 12rem;
}
.pf-name {
  display: block;
  font-weight: 500;
}
.pf-name-link {
  color: inherit;
  text-decoration: none;
}
.pf-name-link:hover {
  text-decoration: underline;
}
.pf-ident {
  display: block;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  font-family: monospace;
}
.pf-col-depots {
  white-space: normal !important;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.pf-value {
  font-weight: 600;
}
.pf-stale,
.pf-cost-source {
  display: block;
  font-size: var(--text-xs);
  color: var(--p-text-muted-color);
}
.pf-cost-source {
  display: inline;
  margin-left: 0.2em;
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

.pf-row {
  cursor: pointer;
}
.pf-row:hover {
  background: var(--p-content-hover-background);
}
.pf-row:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset-inset);
}
.pf-row-active {
  background: var(--p-highlight-background);
}
.pf-row-active .pf-name {
  color: var(--p-highlight-color);
}
.pf-row-closed .pf-name {
  color: var(--p-text-muted-color);
}

.pf-closed-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  cursor: pointer;
}

/* ── Transactions ──────────────────────────────────────────────────── */
.pf-tx-sums {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  font-variant-numeric: tabular-nums;
}
.pf-date {
  font-variant-numeric: tabular-nums;
  color: var(--p-text-muted-color);
}
.pf-kind {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: var(--text-sm);
  background: var(--p-tag-secondary-background);
  color: var(--p-tag-secondary-color);
}
.pf-kind-buy {
  background: var(--p-tag-info-background);
  color: var(--p-tag-info-color);
}
.pf-kind-sell {
  background: var(--p-tag-warn-background);
  color: var(--p-tag-warn-color);
}
.pf-kind-dividend {
  background: var(--p-tag-success-background);
  color: var(--p-tag-success-color);
}
.pf-source {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.pf-more {
  display: flex;
  justify-content: center;
}

@media (max-width: 639px) {
  .pf-table {
    font-size: var(--text-sm);
  }
  .pf-table th,
  .pf-table td {
    padding: 0.35rem 0.4rem;
  }
  .pf-col-name {
    min-width: 9rem;
  }
}
</style>
