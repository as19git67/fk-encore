<script setup lang="ts">
/**
 * Buchungsliste — entweder für ein einzelnes Konto (`/finanzen/uebersicht/konto/:id`)
 * oder für alle Konten einer Sektion (`/finanzen/uebersicht/sektion/:name`).
 *
 * Liefert die 500 neuesten Buchungen ohne Pagination — für ältere
 * Datensätze ist Suche / Filter vorgesehen (Filter-Icon oben rechts;
 * Logik folgt später, derzeit Dummy).
 */

import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useScrollRestore } from '../../composables/useScrollRestore'
import { useModuleBack } from '../../composables/useModuleBack'
import Button from 'primevue/button'
import Chart from 'primevue/chart'
import Message from 'primevue/message'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'
import Checkbox from 'primevue/checkbox'
import Popover from 'primevue/popover'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useOverviewStore } from '../../stores/finance/overview'
import { useTagsStore } from '../../stores/finance/tags'
import { useTxSelectionStore } from '../../stores/finance/selection'
import { useTxFiltersStore } from '../../stores/finance/txFilters'
import { useAuthStore } from '../../stores/auth'
import DateRangePresets from '../../components/DateRangePresets.vue'
import BatchTagDialog from '../../components/finance/BatchTagDialog.vue'
import { toLocalIsoDate } from '../../utils/dateFormat'
import type {
  DepotTransaction,
  DepotTransactionKind,
  Holding,
  HoldingsHistoryPosition,
  HoldingsHistoryResponse,
  ListTransactionsQuery,
  OverviewAccount,
  OverviewSection,
  Transaction,
} from '../../api/finance'
import {
  createDepotTransaction,
  deleteDepotTransaction,
  deriveDepotTransactionsFromGiro,
  getHoldingsHistory,
  listDepotTransactions,
  listHoldings,
} from '../../api/finance'

const route = useRoute()
const router = useRouter()
const txStore = useTransactionsStore()
const overviewStore = useOverviewStore()
const tagsStore = useTagsStore()
const { restore: restoreScroll } = useScrollRestore('finance-transactions')
const selectionStore = useTxSelectionStore()
const filtersStore = useTxFiltersStore()
const authStore = useAuthStore()

const PAGE_LIMIT = 500

// ── Mode resolution ───────────────────────────────────────────────────
//
// One component, two route names. We derive a `mode` from the route
// name and then hand the resolved scope (single account id, or a list
// of account ids) to the store query.

type Mode =
  | { kind: 'account'; accountId: number }
  | { kind: 'section'; sectionName: string }

const mode = computed<Mode | null>(() => {
  if (route.name === 'finance-account-transactions') {
    const id = Number(route.params.id)
    return Number.isInteger(id) && id > 0 ? { kind: 'account', accountId: id } : null
  }
  if (route.name === 'finance-section-transactions') {
    const name = String(route.params.name ?? '').trim()
    return name ? { kind: 'section', sectionName: name } : null
  }
  return null
})

// Resolve the section / single account from the overview store. The
// overview is the source of truth for "which accounts belong to which
// section", so we depend on it being loaded before we know which ids
// to query.

const resolvedAccount = computed<OverviewAccount | null>(() => {
  if (!mode.value || mode.value.kind !== 'account') return null
  const id = mode.value.accountId
  if (!overviewStore.data) return null
  for (const s of overviewStore.data.sections) {
    for (const a of s.accounts) if (a.id === id) return a
  }
  for (const a of overviewStore.data.unassigned) if (a.id === id) return a
  return null
})

const resolvedSection = computed<OverviewSection | null>(() => {
  if (!mode.value || mode.value.kind !== 'section') return null
  if (!overviewStore.data) return null
  const name = mode.value.sectionName
  return overviewStore.data.sections.find((s) => s.name === name) ?? null
})

// ── Header content ────────────────────────────────────────────────────

const headerTitle = computed(() => {
  if (!mode.value) return ''
  if (mode.value.kind === 'account') return resolvedAccount.value?.label ?? '…'
  return mode.value.sectionName
})

const headerBalance = computed<string | null>(() => {
  if (!mode.value || !overviewStore.data) return null
  if (mode.value.kind === 'account') {
    return formatBalance(resolvedAccount.value)
  }
  // Section-Modus: Summe aller Salden der Konten der Sektion. Konten
  // ohne erfassten Saldo zählen als 0.
  const sec = resolvedSection.value
  if (!sec) return null
  let sum = 0
  let currency = 'EUR'
  for (const a of sec.accounts) {
    if (a.balance !== null) {
      const n = Number(a.balance)
      if (Number.isFinite(n)) sum += n
    }
    currency = a.currency_code || currency
  }
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(sum)
})

const headerDate = computed<string | null>(() => {
  if (!mode.value || !overviewStore.data) return null
  if (mode.value.kind === 'account') {
    return formatShortDate(resolvedAccount.value?.balance_as_of ?? null)
  }
  const sec = resolvedSection.value
  if (!sec) return null
  // Take the most recent balance_as_of across the section.
  let latest: string | null = null
  for (const a of sec.accounts) {
    if (a.balance_as_of && (!latest || a.balance_as_of > latest)) {
      latest = a.balance_as_of
    }
  }
  return formatShortDate(latest)
})

function formatBalance(acc: OverviewAccount | null): string | null {
  if (!acc || acc.balance === null) return null
  const n = Number(acc.balance)
  if (!Number.isFinite(n)) return acc.balance
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: acc.currency_code || 'EUR',
  }).format(n)
}

function formatShortDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('de-DE')
}

// ── Filter state ──────────────────────────────────────────────────────
//
// Persisted in useTxFiltersStore so that opening the batch-tag
// dialog (or any subsequent route navigation) does not reset the
// user's search criteria.

const filterPanelOpen = ref(false)
const filterPanelRef = ref<HTMLElement | null>(null)
const filterPanelHeight = ref(0)

let filterRO: ResizeObserver | undefined
watch(filterPanelOpen, async (open) => {
  if (open) {
    await nextTick()
    if (filterPanelRef.value) {
      filterPanelHeight.value = filterPanelRef.value.offsetHeight
      filterRO?.disconnect()
      filterRO = new ResizeObserver(() => {
        filterPanelHeight.value = filterPanelRef.value?.offsetHeight ?? 0
      })
      filterRO.observe(filterPanelRef.value)
    }
  } else {
    filterRO?.disconnect()
    filterRO = undefined
    filterPanelHeight.value = 0
  }
})
onBeforeUnmount(() => filterRO?.disconnect())

// Top offset for tx-select-bar: when filter is open, select-bar moves below it.
const SELECT_BAR_BASE_TOP = 130
const selectBarStyle = computed(() => ({
  top: filterPanelOpen.value
    ? `${SELECT_BAR_BASE_TOP + filterPanelHeight.value}px`
    : `${SELECT_BAR_BASE_TOP}px`,
}))

const formQuery = computed({ get: () => filtersStore.formQuery, set: (v) => { filtersStore.formQuery = v } })
const formTags = computed({ get: () => filtersStore.formTags, set: (v) => { filtersStore.formTags = v } })
const formFrom = computed({ get: () => filtersStore.formFrom, set: (v) => { filtersStore.formFrom = v } })
const formTo = computed({ get: () => filtersStore.formTo, set: (v) => { filtersStore.formTo = v } })

const hasActiveFilters = computed(() => filtersStore.hasActiveFilters)

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

const tagOptions = computed(() =>
  tagsStore.items.map((t) => ({ label: t.name, value: t.name })),
)

// ── Loading transactions ──────────────────────────────────────────────

function buildQuery(): ListTransactionsQuery {
  const m = mode.value
  if (!m) return {}
  const base: ListTransactionsQuery = { limit: PAGE_LIMIT }
  if (m.kind === 'account') {
    base.accountId = m.accountId
  } else {
    const sec = resolvedSection.value
    const ids = sec ? sec.accounts.map((a) => a.id) : []
    if (ids.length === 0) return { __empty: true } as unknown as ListTransactionsQuery
    base.accountIds = ids
  }
  if (filtersStore.appliedQuery.trim().length > 0) base.q = filtersStore.appliedQuery.trim()
  if (filtersStore.appliedTags.length > 0) base.tags = filtersStore.appliedTags
  if (filtersStore.appliedFrom) base.from = isoDate(filtersStore.appliedFrom)
  if (filtersStore.appliedTo) base.to = isoDate(filtersStore.appliedTo)
  return base
}

async function loadTransactions() {
  if (isDepot.value) {
    txStore.items = []
    txStore.total = 0
    return
  }
  const m = mode.value
  if (!m) return
  const query = buildQuery() as ListTransactionsQuery & { __empty?: boolean }
  if (query.__empty) {
    txStore.items = []
    txStore.total = 0
    return
  }
  await txStore.refresh(query)
}

function applyFilters() {
  filtersStore.apply()
  void loadTransactions()
}

function clearFilters() {
  filtersStore.clear()
  filterPanelOpen.value = false
  void loadTransactions()
}

onMounted(async () => {
  if (!overviewStore.data) await overviewStore.refresh()
  if (tagsStore.items.length === 0) {
    // load both user + ai tag names so promoted-but-unfamiliar tags
    // still appear in the filter dropdown.
    await tagsStore.refresh('all')
  }
  await loadTransactions()
  restoreScroll()
})

// React to route changes (navigating from one section/account to
// another without unmounting the component). Filter form state stays
// across the navigation so a user-applied date preset survives a
// switch from one account to another within the same session — the
// applied filters are explicitly account-agnostic.
watch(
  () => [route.name, route.params.id, route.params.name],
  async () => {
    await loadTransactions()
  },
)

// ── Depot holdings (only for kind === "depot") ──────────────────────

const isDepot = computed(() => {
  if (!mode.value || mode.value.kind !== 'account') return false
  return resolvedAccount.value?.type_kind === 'depot'
})

const canAddCashTransaction = computed(() =>
  mode.value?.kind === 'account' &&
  resolvedAccount.value?.type_kind === 'bargeld' &&
  authStore.hasPermission('finance.accounts.manage'),
)

function openCashTransactionForm() {
  if (!mode.value || mode.value.kind !== 'account') return
  void router.push({
    name: 'finance-transaction-new',
    query: { accountId: mode.value.accountId },
  })
}

const holdings = ref<Holding[]>([])
const holdingsAsOf = ref<string | null>(null)
const holdingsLoading = ref(false)

async function loadHoldings() {
  if (!isDepot.value || !mode.value || mode.value.kind !== 'account') {
    holdings.value = []
    holdingsAsOf.value = null
    return
  }
  holdingsLoading.value = true
  try {
    const resp = await listHoldings(mode.value.accountId)
    holdings.value = resp.items
    holdingsAsOf.value = resp.as_of
  } catch {
    holdings.value = []
    holdingsAsOf.value = null
  } finally {
    holdingsLoading.value = false
  }
}

const holdingsTotal = computed(() => {
  let sum = 0
  for (const h of holdings.value) {
    const v = Number(h.value)
    if (Number.isFinite(v)) sum += v
  }
  return sum
})

function formatCurrency(val: string | number | null, currency?: string): string {
  if (val === null) return '–'
  const n = typeof val === 'number' ? val : Number(val)
  if (!Number.isFinite(n)) return String(val)
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(n)
}

function formatAmount(val: string | null): string {
  if (val === null) return '–'
  const n = Number(val)
  if (!Number.isFinite(n)) return val
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(n)
}

function holdingShare(h: Holding): string {
  if (holdingsTotal.value === 0 || h.value === null) return '–'
  const pct = (Number(h.value) / holdingsTotal.value) * 100
  return pct.toFixed(1) + ' %'
}

watch(isDepot, (v) => { if (v) void loadHoldings() }, { immediate: true })
watch(
  () => mode.value && mode.value.kind === 'account' ? mode.value.accountId : null,
  () => { if (isDepot.value) void loadHoldings() },
)

// ── Depot value history (Phase 1 of #439 / #428) ─────────────────────
//
// Pulls /finance/accounts/:id/holdings/history once we know it's a
// depot account. The endpoint returns:
//   - totals[]:    per-as_of SUM(value)  → main line chart
//   - positions[]: per-position points[] → per-position sparkline
//
// We render the main chart unconditionally for depots that have ≥ 2
// snapshots. The per-position sparkline is opt-in: clicking a row in
// the positions table toggles a small chart underneath.

const darkMQ = window.matchMedia('(prefers-color-scheme: dark)')
const isDark = ref(darkMQ.matches)
function onDarkChange(e: MediaQueryListEvent) {
  isDark.value = e.matches
}
onMounted(() => darkMQ.addEventListener('change', onDarkChange))
onUnmounted(() => darkMQ.removeEventListener('change', onDarkChange))

const history = ref<HoldingsHistoryResponse | null>(null)
const historyLoading = ref(false)
const expandedPositionKey = ref<string | null>(null)

async function loadHistory() {
  if (!isDepot.value || !mode.value || mode.value.kind !== 'account') {
    history.value = null
    return
  }
  historyLoading.value = true
  try {
    history.value = await getHoldingsHistory(mode.value.accountId)
  } catch {
    history.value = null
  } finally {
    historyLoading.value = false
  }
}

watch(isDepot, (v) => { if (v) void loadHistory() }, { immediate: true })
watch(
  () => mode.value && mode.value.kind === 'account' ? mode.value.accountId : null,
  () => { if (isDepot.value) { expandedPositionKey.value = null; void loadHistory() } },
)

function togglePositionHistory(h: Holding) {
  // Same identity as the API uses (COALESCE(isin, wkn, name)).
  const key = h.isin || h.wkn || h.name || ''
  if (!key) return
  expandedPositionKey.value = expandedPositionKey.value === key ? null : key
}

function positionSeries(h: Holding): HoldingsHistoryPosition | null {
  if (!history.value) return null
  const key = h.isin || h.wkn || h.name || ''
  return history.value.positions.find((p) => p.key === key) ?? null
}

function chartAxisColors() {
  return {
    tick: isDark.value ? '#94a3b8' : '#64748b',
    grid: isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
  }
}

const totalChartData = computed(() => {
  if (!history.value || history.value.totals.length < 2) return null
  return {
    labels: history.value.totals.map((p) => p.as_of),
    datasets: [
      {
        label: 'Depot-Gesamtwert',
        data: history.value.totals.map((p) => Number(p.total_value)),
        borderColor: isDark.value ? '#fbbf24' : '#2563eb',
        backgroundColor: isDark.value ? 'rgba(251,191,36,0.15)' : 'rgba(37,99,235,0.15)',
        fill: true,
        tension: 0.25,
        pointRadius: 2,
      },
    ],
  }
})

const totalChartOptions = computed(() => {
  const { tick, grid } = chartAxisColors()
  const currency = history.value?.totals.find((t) => t.currency)?.currency || 'EUR'
  const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency })
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { parsed: { y: number } }) => fmt.format(ctx.parsed.y),
        },
      },
    },
    scales: {
      x: { ticks: { color: tick, maxRotation: 0, autoSkip: true }, grid: { color: grid } },
      y: {
        ticks: {
          color: tick,
          callback: (val: number | string) =>
            fmt.format(typeof val === 'number' ? val : Number(val)),
        },
        grid: { color: grid },
      },
    },
  }
})

type SparklineMetric = 'value' | 'price'
const sparklineMetric = ref<SparklineMetric>('value')

function sparklineData(series: HoldingsHistoryPosition | null) {
  if (!series || series.points.length < 2) return null
  const metric = sparklineMetric.value
  const data = series.points.map((p) => {
    const raw = metric === 'value' ? p.value : p.price
    return raw === null ? null : Number(raw)
  })
  return {
    labels: series.points.map((p) => p.as_of),
    datasets: [
      {
        label: metric === 'value' ? 'Wert' : 'Kurs',
        data,
        borderColor: isDark.value ? '#fbbf24' : '#2563eb',
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        spanGaps: false,
      },
    ],
  }
}

function sparklineOptions(series: HoldingsHistoryPosition | null) {
  const { tick, grid } = chartAxisColors()
  const currency = series?.currency || 'EUR'
  const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency })
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { parsed: { y: number } }) => fmt.format(ctx.parsed.y),
        },
      },
    },
    scales: {
      x: { ticks: { color: tick, maxRotation: 0, autoSkip: true }, grid: { color: grid } },
      y: {
        ticks: {
          color: tick,
          callback: (val: number | string) =>
            fmt.format(typeof val === 'number' ? val : Number(val)),
        },
        grid: { color: grid },
      },
    },
  }
}

// ── Depot transactions per position (Phase 2 of #439 / #428) ─────────
//
// Loaded lazily when a position row is expanded. Keyed by the same
// COALESCE(isin, wkn, name) identity used elsewhere.

const depotTxByKey = ref<Record<string, DepotTransaction[]>>({})
const depotTxLoadingKey = ref<string | null>(null)
const depotTxError = ref<string | null>(null)

const KIND_LABELS: Record<string, string> = {
  buy: 'Kauf',
  sell: 'Verkauf',
  in: 'Einbuchung',
  out: 'Ausbuchung',
  dividend: 'Ertrag',
  split: 'Split',
  corp_action: 'Kapitalmaßnahme',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function positionKeyOf(h: Holding): string {
  return h.isin || h.wkn || h.name || ''
}

async function loadDepotTransactions(h: Holding) {
  if (!mode.value || mode.value.kind !== 'account') return
  const key = positionKeyOf(h)
  if (!key) return
  depotTxLoadingKey.value = key
  depotTxError.value = null
  try {
    const resp = await listDepotTransactions(mode.value.accountId, {
      ...(h.isin ? { isin: h.isin } : h.wkn ? { wkn: h.wkn } : {}),
    })
    depotTxByKey.value = { ...depotTxByKey.value, [key]: resp.items }
  } catch (e) {
    depotTxError.value = e instanceof Error ? e.message : String(e)
  } finally {
    depotTxLoadingKey.value = null
  }
}

function depotTransactionsFor(h: Holding): DepotTransaction[] {
  return depotTxByKey.value[positionKeyOf(h)] ?? []
}

// ── Add-transaction form ──────────────────────────────────────────────

const addFormKey = ref<string | null>(null)
const addFormSaving = ref(false)
const addForm = ref<{
  kind: DepotTransactionKind
  executed_at: Date | null
  amount: string
  price: string
  fees: string
  net_amount: string
  note: string
}>({
  kind: 'buy',
  executed_at: new Date(),
  amount: '',
  price: '',
  fees: '',
  net_amount: '',
  note: '',
})

const KIND_OPTIONS: { label: string; value: DepotTransactionKind }[] = [
  { label: 'Kauf', value: 'buy' },
  { label: 'Verkauf', value: 'sell' },
  { label: 'Ertrag', value: 'dividend' },
  { label: 'Einbuchung', value: 'in' },
  { label: 'Ausbuchung', value: 'out' },
  { label: 'Split', value: 'split' },
  { label: 'Kapitalmaßnahme', value: 'corp_action' },
]

function openAddForm(h: Holding) {
  addFormKey.value = positionKeyOf(h)
  addForm.value = {
    kind: 'buy',
    executed_at: new Date(),
    amount: '',
    price: '',
    fees: '',
    net_amount: '',
    note: '',
  }
}

function cancelAddForm() {
  addFormKey.value = null
}

function numOrNull(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

async function submitAddForm(h: Holding) {
  if (!mode.value || mode.value.kind !== 'account') return
  if (!addForm.value.executed_at) {
    depotTxError.value = 'Datum erforderlich'
    return
  }
  addFormSaving.value = true
  depotTxError.value = null
  try {
    await createDepotTransaction(mode.value.accountId, {
      isin: h.isin,
      wkn: h.wkn,
      name: h.name,
      kind: addForm.value.kind,
      executed_at: toLocalIsoDate(addForm.value.executed_at),
      amount: numOrNull(addForm.value.amount),
      price: numOrNull(addForm.value.price),
      fees: numOrNull(addForm.value.fees),
      net_amount: numOrNull(addForm.value.net_amount),
      note: addForm.value.note.trim() || null,
    })
    addFormKey.value = null
    await loadDepotTransactions(h)
  } catch (e) {
    depotTxError.value = e instanceof Error ? e.message : String(e)
  } finally {
    addFormSaving.value = false
  }
}

async function removeDepotTransaction(h: Holding, tx: DepotTransaction) {
  depotTxError.value = null
  try {
    await deleteDepotTransaction(tx.id)
    await loadDepotTransactions(h)
  } catch (e) {
    depotTxError.value = e instanceof Error ? e.message : String(e)
  }
}

// When a position is expanded, fetch its transactions once.
watch(expandedPositionKey, (key) => {
  if (!key) return
  if (depotTxByKey.value[key]) return
  const h = holdings.value.find((x) => positionKeyOf(x) === key)
  if (h) void loadDepotTransactions(h)
})

// ── Derive depot transactions from giro bookings (Phase 2b) ──────────
//
// One-click backfill: scans SECU-flagged giro bookings on the same
// bankcontact, matches via ISIN to holdings, writes source='giro-derived'
// rows. Idempotent — safe to call after each sync.

const deriveLoading = ref(false)
const deriveMessage = ref<{ severity: 'success' | 'info' | 'error'; text: string } | null>(null)

// Backend gates this strictly (write ACL + linked bankcontact); the
// frontend only hides the button on non-depot screens. Manual depots
// will see a server-side error if they trigger it, which surfaces in
// `deriveMessage` — acceptable for a rarely-used backfill action.
const canDeriveDepotTx = computed(() => isDepot.value)

async function runDerivation() {
  if (!mode.value || mode.value.kind !== 'account') return
  deriveLoading.value = true
  deriveMessage.value = null
  try {
    const resp = await deriveDepotTransactionsFromGiro(mode.value.accountId)
    if (resp.derived > 0) {
      deriveMessage.value = {
        severity: 'success',
        text: `${resp.derived} neue Transaktion${resp.derived === 1 ? '' : 'en'} aus Giro-Buchungen abgeleitet.`,
      }
    } else if (resp.duplicates > 0) {
      deriveMessage.value = {
        severity: 'info',
        text: 'Keine neuen Transaktionen — bereits alles abgeleitet.',
      }
    } else {
      deriveMessage.value = {
        severity: 'info',
        text: 'Keine passenden Wertpapier-Buchungen im Giro-Konto gefunden.',
      }
    }
    // Refresh per-position lists that are already loaded so the new
    // rows show up immediately.
    for (const key of Object.keys(depotTxByKey.value)) {
      const h = holdings.value.find((x) => positionKeyOf(x) === key)
      if (h) await loadDepotTransactions(h)
    }
  } catch (e) {
    deriveMessage.value = {
      severity: 'error',
      text: e instanceof Error ? e.message : String(e),
    }
  } finally {
    deriveLoading.value = false
  }
}

// ── Transaction grouping (by booking_date) ───────────────────────────

interface DayGroup {
  date: string
  label: string
  items: Transaction[]
}

const groupedTransactions = computed<DayGroup[]>(() => {
  const byDate = new Map<string, Transaction[]>()
  for (const tx of txStore.items) {
    const d = tx.booking_date
    let list = byDate.get(d)
    if (!list) {
      list = []
      byDate.set(d, list)
    }
    list.push(tx)
  }
  // Tagesgruppen absteigend (neueste oben). Innerhalb eines Tages
  // nach id desc — die Insertion-Reihenfolge der DB ist eine grobe
  // Annäherung an "zuletzt importiert", reicht als Tiebreaker.
  const dates = [...byDate.keys()].sort().reverse()
  return dates.map((d) => ({
    date: d,
    label: formatGroupDate(d),
    items: byDate.get(d)!.slice().sort((a, b) => b.id - a.id),
  }))
})

function formatGroupDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE')
}

function formatTxAmount(tx: Transaction): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: tx.currency_code || 'EUR',
  }).format(Number(tx.amount))
}

function txAmountClass(tx: Transaction): string {
  const n = Number(tx.amount)
  if (!Number.isFinite(n) || n === 0) return 'tx-amount tx-amount-neutral'
  return n < 0 ? 'tx-amount tx-amount-negative' : 'tx-amount tx-amount-positive'
}

function openTransaction(tx: Transaction) {
  if (selectMode.value) {
    toggleLocalSelection(tx)
    return
  }
  void router.push({
    name: 'finance-transaction-detail',
    params: { id: tx.id },
  })
}

// ── Select mode + multi-selection state ───────────────────────────────
//
// Local, transient selection — deliberately decoupled from the global
// basket. Picking/un-picking transactions here only affects the list's
// own working set; nothing flows into the basket until the user
// explicitly hits the "in den Warenkorb" action.

const selectMode = ref(false)
const selectionPopover = ref<InstanceType<typeof Popover> | null>(null)
const localSelectedIds = ref<Set<number>>(new Set())

function isLocallySelected(id: number): boolean {
  return localSelectedIds.value.has(id)
}

function toggleLocalSelection(tx: Transaction) {
  const next = new Set(localSelectedIds.value)
  if (next.has(tx.id)) next.delete(tx.id)
  else next.add(tx.id)
  localSelectedIds.value = next
}

const localSelectedItems = computed<Transaction[]>(() =>
  txStore.items.filter((tx) => localSelectedIds.value.has(tx.id)),
)
const localSelectionCount = computed(() => localSelectedItems.value.length)

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) {
    localSelectedIds.value = new Set()
    selectionPopover.value?.hide()
  }
}

/**
 * Tristate state for the "select all" checkbox above the list:
 *   - true   → every visible transaction is selected
 *   - false  → none selected
 *   - null   → at least one is selected (Checkbox renders the
 *              indeterminate/dash glyph)
 */
const selectAllState = computed<boolean | null>(() => {
  const visibleCount = txStore.items.length
  const selectedCount = txStore.items.filter((tx) =>
    localSelectedIds.value.has(tx.id),
  ).length
  if (selectedCount === 0) return false
  if (selectedCount === visibleCount && visibleCount > 0) return true
  return null
})

function toggleSelectAll(checked: boolean | null) {
  // PrimeVue's binary checkbox emits true/false; we never expect null
  // here. Treat anything truthy as "select all visible", else clear.
  if (checked) {
    localSelectedIds.value = new Set(txStore.items.map((tx) => tx.id))
  } else {
    localSelectedIds.value = new Set()
  }
}

function clearSelection() {
  localSelectedIds.value = new Set()
  selectionPopover.value?.hide()
  selectMode.value = false
}

function openSelectionPopover(event: Event) {
  if (localSelectionCount.value === 0) return
  selectionPopover.value?.toggle(event)
}

const localSelectionSum = computed(() =>
  localSelectedItems.value.reduce(
    (acc, t) => acc + Number(t.amount || 0),
    0,
  ),
)
const localSelectionCurrency = computed(
  () => localSelectedItems.value[0]?.currency_code ?? 'EUR',
)

function formatSelectionSum(): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: localSelectionCurrency.value,
  }).format(localSelectionSum.value)
}

function addLocalSelectionToBasket() {
  if (localSelectionCount.value === 0) return
  for (const tx of localSelectedItems.value) {
    selectionStore.add(tx)
  }
  // Keep the list selection — the user might want to follow up with
  // tagging or another action. Just close the popover so the change in
  // basket count is visible.
  selectionPopover.value?.hide()
}

// Sum + currency over the currently displayed (= filtered) listing.
// Used in the header when filters are active but the user isn't in
// select mode — answers "wieviel habe ich für X ausgegeben" for the
// current filter set without forcing the user into select-all.
const filteredSum = computed(() => {
  let sum = 0
  for (const tx of txStore.items) {
    const n = Number(tx.amount)
    if (Number.isFinite(n)) sum += n
  }
  return sum
})

const filteredCurrency = computed(
  () => txStore.items[0]?.currency_code ?? 'EUR',
)

function formatFilteredSum(): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: filteredCurrency.value,
  }).format(filteredSum.value)
}

const batchTagDialogVisible = ref(false)

function openBatchTagEditor() {
  if (localSelectionCount.value === 0) return
  selectionPopover.value?.hide()
  batchTagDialogVisible.value = true
}

async function refreshAfterTagChange() {
  // Tags changed server-side — reload the list so cards reflect the
  // new tag set. Local selection survives because the ids are kept;
  // anything that left the page after the refresh simply drops out of
  // the visible selection but doesn't trigger any other side effect.
  await loadTransactions()
}

const { goBack: moduleBack } = useModuleBack('/finanzen', 'finance-overview')

function goBack() {
  if (selectMode.value) {
    // Leaving select mode is the more useful action than navigating
    // away when the user expects "Zurück" → list-without-selection.
    selectMode.value = false
    localSelectedIds.value = new Set()
    return
  }
  moduleBack()
}
</script>

<template>
  <div class="page">
    <header class="tx-header">
      <Button
        icon="pi pi-chevron-left"
        severity="secondary"
        rounded
        aria-label="Zurück"
        @click="goBack"
      />
      <template v-if="selectMode">
        <div class="tx-header-title">
          <h1>Σ: {{ formatSelectionSum() }}</h1>
        </div>
        <div class="tx-header-meta">
          <span class="tx-header-date">
            {{ localSelectionCount }} Buchung{{ localSelectionCount === 1 ? '' : 'en' }}
          </span>
        </div>
      </template>
      <template v-else-if="hasActiveFilters">
        <div class="tx-header-title">
          <h1>Σ: {{ formatFilteredSum() }}</h1>
        </div>
        <div class="tx-header-meta">
          <span class="tx-header-date">
            {{ txStore.items.length }} Buchung{{ txStore.items.length === 1 ? '' : 'en' }}
          </span>
        </div>
      </template>
      <template v-else>
        <div class="tx-header-title">
          <h1>{{ headerTitle }}</h1>
        </div>
        <div class="tx-header-meta">
          <span v-if="headerBalance" class="tx-header-balance">
            {{ headerBalance }}
          </span>
          <span v-if="headerDate" class="tx-header-date">{{ headerDate }}</span>
        </div>
      </template>
      <div v-if="!isDepot" class="tx-header-actions">
        <Button
          v-if="canAddCashTransaction"
          icon="pi pi-money-bill"
          severity="secondary"
          rounded
          aria-label="Bargeldbuchung erfassen"
          title="Bargeldbuchung erfassen"
          @click="openCashTransactionForm"
        />
        <Button
          icon="pi pi-filter"
          severity="secondary"
          rounded
          aria-label="Filter"
          :class="{
            'tx-icon-active': filterPanelOpen,
            'tx-icon-applied': hasActiveFilters && !filterPanelOpen,
          }"
          @click="filterPanelOpen = !filterPanelOpen"
        />
        <Button
          icon="pi pi-list"
          severity="secondary"
          rounded
          aria-label="Liste der ausgewählten Buchungen"
          :disabled="!selectMode || localSelectionCount === 0"
          :class="{ 'tx-icon-active': selectMode && localSelectionCount > 0 }"
          @click="openSelectionPopover"
        />
        <Button
          icon="pi pi-check-square"
          severity="secondary"
          rounded
          aria-label="Auswählen"
          :class="{ 'tx-icon-active': selectMode }"
          @click="toggleSelectMode"
        />
      </div>
    </header>

    <!--
      Selection popover (anchored to the list-button). Mirrors the
      mock: each selected transaction with a counterparty + purpose
      preview and an X to deselect individually.
    -->
    <Popover ref="selectionPopover" class="tx-selection-popover">
      <h3 class="tx-selection-title">Ausgewählte Buchungen:</h3>
      <ul class="tx-selection-list">
        <li
          v-for="tx in localSelectedItems"
          :key="tx.id"
          class="tx-selection-row"
        >
          <div class="tx-selection-body">
            <div class="tx-selection-name">
              {{ tx.counterparty || '(ohne Gegenseite)' }}
            </div>
            <div v-if="tx.purpose" class="tx-selection-purpose">
              {{ tx.purpose }}
            </div>
          </div>
          <div class="tx-selection-x">
            <Button
              icon="pi pi-times-circle"
              severity="secondary"
              text
              rounded
              aria-label="Buchung aus Auswahl entfernen"
              @click="toggleLocalSelection(tx)"
            />
          </div>
        </li>
      </ul>
    </Popover>

    <section
      v-if="filterPanelOpen"
      ref="filterPanelRef"
      class="tx-filter-panel"
    >
      <div class="tx-filter-fields">
        <div class="tx-filter-row">
          <InputText
            v-model="formQuery"
            placeholder="Text oder Betrag suchen"
            class="tx-filter-input"
            @keyup.enter="applyFilters"
          />
          <Button
            v-if="formQuery.length > 0"
            icon="pi pi-times"
            severity="secondary"
            text
            rounded
            aria-label="Suchtext leeren"
            @click="() => { formQuery = ''; if (!formTags.length && !formFrom && !formTo) filterPanelOpen = false }"
          />
        </div>
        <MultiSelect
          v-model="formTags"
          :options="tagOptions"
          option-label="label"
          option-value="value"
          placeholder="Tags auswählen"
          :max-selected-labels="2"
          filter
          display="chip"
          class="tx-filter-input"
        />
        <DateRangePresets
          v-model:from="formFrom"
          v-model:to="formTo"
        />
      </div>
      <div class="tx-filter-actions">
        <Button
          icon="pi pi-search"
          aria-label="Suchen"
          @click="applyFilters"
        />
        <Button
          icon="pi pi-times"
          severity="secondary"
          aria-label="Filter zurücksetzen"
          :disabled="!hasActiveFilters && formQuery.length === 0 && formTags.length === 0 && !formFrom && !formTo"
          @click="clearFilters"
        />
      </div>
    </section>

    <!--
      Tristate "select all" + batch action row, only in select mode.
      Sits below the filter panel (if open) via dynamic top offset.
    -->
    <div v-if="selectMode" class="tx-select-bar" :style="selectBarStyle">
      <div class="tx-select-bar-left">
        <Checkbox
          :model-value="selectAllState === true"
          :indeterminate="selectAllState === null"
          :binary="true"
          aria-label="Alle Buchungen auswählen"
          @update:model-value="toggleSelectAll"
        />
        <span class="tx-select-count">
          {{ localSelectionCount }} ausgewählt
        </span>
      </div>
      <div class="tx-select-bar-actions">
        <Button
            icon="pi pi-tag"
            severity="secondary"
            aria-label="Tags auf Auswahl anwenden"
            :disabled="localSelectionCount === 0"
            @click="openBatchTagEditor"
        />
        <Button
            icon="pi pi-shopping-cart"
            severity="secondary"
            aria-label="Auswahl in den Warenkorb geben"
            title="Auswahl in den Warenkorb geben"
            :disabled="localSelectionCount === 0"
            @click="addLocalSelectionToBasket"
        />
        <Button
            icon="pi pi-times"
            severity="secondary"
            aria-label="Nichts auswählen"
            :disabled="localSelectionCount === 0"
            @click="clearSelection"
        />
      </div>
    </div>

    <!-- ── Holdings table (depot accounts only) ─────────────────────── -->
    <section v-if="isDepot" class="holdings-section">
      <div class="holdings-section-head">
        <h2 class="holdings-title">
          Positionen
          <span v-if="holdingsAsOf" class="holdings-date">
            ({{ formatShortDate(holdingsAsOf) }})
          </span>
        </h2>
        <Button
          v-if="canDeriveDepotTx"
          label="Aus Giro ableiten"
          icon="pi pi-sync"
          size="small"
          severity="secondary"
          :loading="deriveLoading"
          aria-label="Wertpapier-Transaktionen aus Giro-Buchungen ableiten"
          @click="runDerivation"
        />
      </div>
      <Message
        v-if="deriveMessage"
        :severity="deriveMessage.severity"
        :closable="true"
        @close="deriveMessage = null"
      >
        {{ deriveMessage.text }}
      </Message>

      <!-- Depot value over time -->
      <div v-if="historyLoading" class="tx-loading">Lädt Wertverlauf …</div>
      <div v-else-if="totalChartData" class="depot-history-wrap">
        <Chart
          type="line"
          :data="totalChartData"
          :options="totalChartOptions"
          class="depot-history-chart"
        />
      </div>
      <p
        v-else-if="history && history.totals.length < 2"
        class="depot-history-hint"
      >
        Wertverlauf wird verfügbar, sobald mindestens zwei Tages-Snapshots
        vorliegen.
      </p>

      <div v-if="holdingsLoading" class="tx-loading">Lädt Positionen …</div>
      <div v-else-if="holdings.length === 0" class="tx-empty">Keine Positionen vorhanden.</div>
      <div v-else class="holdings-table-wrap">
        <table class="holdings-table">
          <thead>
            <tr>
              <th class="holdings-col-name">Name / ISIN</th>
              <th class="holdings-col-num">
                <span class="thead-full">Stück</span>
                <span class="thead-short">Stk</span>
              </th>
              <th class="holdings-col-num">Kurs</th>
              <th class="holdings-col-num">Wert</th>
              <th class="holdings-col-num holdings-col-share">Anteil</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="h in holdings" :key="h.id">
              <tr
                class="holdings-row"
                :class="{
                  'holdings-row-expanded':
                    expandedPositionKey === (h.isin || h.wkn || h.name || ''),
                }"
                @click="togglePositionHistory(h)"
              >
                <td class="holdings-col-name">
                  <span class="holdings-name">{{ h.name || '–' }}</span>
                  <span class="holdings-isin">{{ h.isin || h.wkn || '' }}</span>
                </td>
                <td class="holdings-col-num">{{ formatAmount(h.amount) }}</td>
                <td class="holdings-col-num">{{ formatCurrency(h.price, h.currency ?? undefined) }}</td>
                <td class="holdings-col-num holdings-value">{{ formatCurrency(h.value, h.currency ?? undefined) }}</td>
                <td class="holdings-col-num holdings-col-share">{{ holdingShare(h) }}</td>
              </tr>
              <tr
                v-if="expandedPositionKey === (h.isin || h.wkn || h.name || '')"
                class="holdings-history-row"
              >
                <td colspan="5">
                  <div class="holdings-history-head">
                    <span class="holdings-history-label">Verlauf</span>
                    <div class="holdings-history-toggle">
                      <Button
                        :label="sparklineMetric === 'value' ? 'Wert' : 'Kurs'"
                        size="small"
                        text
                        @click.stop="
                          sparklineMetric =
                            sparklineMetric === 'value' ? 'price' : 'value'
                        "
                      />
                    </div>
                  </div>
                  <div
                    v-if="
                      sparklineData(positionSeries(h)) &&
                      positionSeries(h)!.points.length >= 2
                    "
                    class="holdings-sparkline-wrap"
                  >
                    <Chart
                      type="line"
                      :data="sparklineData(positionSeries(h))!"
                      :options="sparklineOptions(positionSeries(h))"
                      class="holdings-sparkline"
                    />
                  </div>
                  <p v-else class="holdings-history-empty">
                    Noch keine Verlaufs-Datenpunkte für diese Position.
                  </p>

                  <!-- Per-position transactions (Phase 2) -->
                  <div class="depot-tx">
                    <div class="depot-tx-head">
                      <span class="holdings-history-label">Transaktionen</span>
                      <Button
                        v-if="addFormKey !== (h.isin || h.wkn || h.name || '')"
                        label="Hinzufügen"
                        icon="pi pi-plus"
                        size="small"
                        text
                        @click.stop="openAddForm(h)"
                      />
                    </div>

                    <Message
                      v-if="depotTxError"
                      severity="error"
                      :closable="true"
                      @close="depotTxError = null"
                    >
                      {{ depotTxError }}
                    </Message>

                    <!-- Add form -->
                    <div
                      v-if="addFormKey === (h.isin || h.wkn || h.name || '')"
                      class="depot-tx-form"
                      @click.stop
                    >
                      <div class="depot-tx-form-grid">
                        <label class="depot-tx-field">
                          <span>Art</span>
                          <Select
                            v-model="addForm.kind"
                            :options="KIND_OPTIONS"
                            option-label="label"
                            option-value="value"
                            size="small"
                          />
                        </label>
                        <label class="depot-tx-field">
                          <span>Datum</span>
                          <DatePicker
                            v-model="addForm.executed_at"
                            date-format="dd.mm.yy"
                            show-icon
                            size="small"
                          />
                        </label>
                        <label class="depot-tx-field">
                          <span>Stück</span>
                          <InputText v-model="addForm.amount" inputmode="decimal" placeholder="z. B. 5" />
                        </label>
                        <label class="depot-tx-field">
                          <span>Kurs</span>
                          <InputText v-model="addForm.price" inputmode="decimal" placeholder="z. B. 200" />
                        </label>
                        <label class="depot-tx-field">
                          <span>Gebühren</span>
                          <InputText v-model="addForm.fees" inputmode="decimal" placeholder="z. B. 9,90" />
                        </label>
                        <label class="depot-tx-field">
                          <span>Betrag (netto)</span>
                          <InputText v-model="addForm.net_amount" inputmode="decimal" placeholder="z. B. 1009,90" />
                        </label>
                        <label class="depot-tx-field depot-tx-field-wide">
                          <span>Notiz</span>
                          <InputText v-model="addForm.note" placeholder="optional" />
                        </label>
                      </div>
                      <div class="depot-tx-form-actions">
                        <Button label="Abbrechen" severity="secondary" text size="small" @click="cancelAddForm" />
                        <Button label="Speichern" size="small" :loading="addFormSaving" @click="submitAddForm(h)" />
                      </div>
                    </div>

                    <div
                      v-if="depotTxLoadingKey === (h.isin || h.wkn || h.name || '')"
                      class="holdings-history-empty"
                    >
                      Lädt Transaktionen …
                    </div>
                    <table
                      v-else-if="depotTransactionsFor(h).length > 0"
                      class="depot-tx-table"
                    >
                      <thead>
                        <tr>
                          <th>Datum</th>
                          <th>Art</th>
                          <th class="holdings-col-num">Stück</th>
                          <th class="holdings-col-num">Kurs</th>
                          <th class="holdings-col-num">Betrag</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="tx in depotTransactionsFor(h)" :key="tx.id">
                          <td>{{ formatShortDate(tx.executed_at) }}</td>
                          <td>
                            {{ kindLabel(tx.kind) }}
                            <span v-if="tx.source !== 'manual'" class="depot-tx-source">{{ tx.source }}</span>
                          </td>
                          <td class="holdings-col-num">{{ formatAmount(tx.amount) }}</td>
                          <td class="holdings-col-num">{{ formatCurrency(tx.price, tx.currency ?? undefined) }}</td>
                          <td class="holdings-col-num">{{ formatCurrency(tx.net_amount ?? tx.gross_amount, tx.currency ?? undefined) }}</td>
                          <td class="holdings-col-num">
                            <Button
                              v-if="tx.source === 'manual'"
                              icon="pi pi-trash"
                              severity="danger"
                              text
                              size="small"
                              aria-label="Transaktion löschen"
                              @click.stop="removeDepotTransaction(h, tx)"
                            />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      v-else-if="addFormKey !== (h.isin || h.wkn || h.name || '')"
                      class="holdings-history-empty"
                    >
                      Noch keine Transaktionen erfasst.
                    </p>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
          <tfoot>
            <tr>
              <td class="holdings-col-name" colspan="3">Gesamt</td>
              <td class="holdings-col-num holdings-value">{{ formatCurrency(holdingsTotal) }}</td>
              <td class="holdings-col-num holdings-col-share">100 %</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <Message v-if="txStore.error" severity="error" :closable="false">
      {{ txStore.error }}
    </Message>

    <div v-if="txStore.loading" class="tx-loading">Lädt …</div>

    <div
      v-else-if="groupedTransactions.length === 0 && !isDepot"
      class="tx-empty"
    >
      Keine Buchungen vorhanden.
    </div>

    <template v-else>
      <section
        v-for="group in groupedTransactions"
        :key="group.date"
        class="tx-day"
      >
        <h2 class="tx-day-header">{{ group.label }}</h2>
        <ul class="tx-list">
          <li
            v-for="tx in group.items"
            :key="tx.id"
            class="tx-card"
            :class="{
              'tx-card-selected': isLocallySelected(tx.id),
              'tx-card-select-mode': selectMode,
            }"
            @click="openTransaction(tx)"
          >
            <div v-if="selectMode" class="tx-card-lead" @click.stop>
              <Checkbox
                :model-value="isLocallySelected(tx.id)"
                :binary="true"
                aria-label="Buchung auswählen"
                @update:model-value="toggleLocalSelection(tx)"
              />
            </div>
            <div class="tx-card-body">
              <div class="tx-counterparty">
                {{ tx.counterparty || '(ohne Gegenseite)' }}
              </div>
              <div v-if="tx.purpose" class="tx-purpose">
                {{ tx.purpose }}
              </div>
              <div v-if="tx.notice" class="tx-notice">
                <i class="pi pi-file-edit" />
                {{ tx.notice }}
              </div>
              <div v-if="tx.tags.length > 0" class="tx-tags">
                <span
                  v-for="t in tx.tags"
                  :key="t.name + t.source"
                  class="p-tag tag-chip"
                  :class="`p-tag-${t.source === 'ai' ? 'success' : 'info'}`"
                >
                  {{ t.name }}
                </span>
              </div>
            </div>
            <div :class="txAmountClass(tx)">{{ formatTxAmount(tx) }}</div>
          </li>
        </ul>
      </section>

      <p v-if="txStore.items.length >= PAGE_LIMIT" class="tx-cap-hint">
        Es werden die {{ PAGE_LIMIT }} neuesten Buchungen angezeigt. Für ältere
        Buchungen verwende den Filter.
      </p>
    </template>

    <BatchTagDialog
      v-model:visible="batchTagDialogVisible"
      :transactions="localSelectedItems"
      @applied="refreshAfterTagChange"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}
@media (max-width: 640px) {
  .page {
    padding: 0.5rem;
  }
}

/* ── Header ─────────────────────────────────────────────────────────── */
.tx-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'back title actions'
    'back meta  actions';
  align-items: center;
  gap: 0.5rem 0.75rem;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
  padding: 0.6rem 0.75rem;
  border-radius: 0.5rem;
  position: sticky;
  top: 58px;
  z-index: 1;
}
.tx-header :deep(.p-button) {
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid transparent;
  color: var(--p-primary-contrast-color);
}
.tx-header :deep(.p-button:hover) {
  background: rgba(255, 255, 255, 0.3);
}
.tx-header :deep(.p-button.tx-icon-active) {
  background: var(--p-warn-color, #f97316);
  color: #fff;
}
.tx-header :deep(.p-button.tx-icon-applied) {
  background: var(--p-warn-color, #f97316);
  color: #fff;
}
.tx-header :deep(.p-button:disabled) {
  opacity: 0.55;
}

/* ── Select-mode bar (tristate + batch actions) ───────────────────── */
.tx-select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  position: sticky;
  top: 120px;
  z-index: 1;
}
.tx-select-bar-left {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.tx-select-count {
  font-weight: 600;
  color: var(--p-text-color);
}
.tx-select-bar-actions {
  display: flex;
  gap: 0.4rem;
}

/* ── Per-card lead slot (selection checkbox) ─────────────────────── */
.tx-card-lead {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.tx-card-select-mode {
  gap: 0.6rem;
}

/* ── Selection popover ────────────────────────────────────────────── */
.tx-selection-popover :deep(.p-popover-content) {
  padding: 0.75rem;
}
.tx-selection-title {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  font-weight: 600;
}
.tx-selection-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 50vh;
  min-width: 16rem;
  overflow-y: auto;
}
.tx-selection-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.tx-selection-row:last-child {
  border-bottom: none;
}
.tx-selection-body {
  flex: 1;
  min-width: 0;
}
.tx-selection-name {
  font-weight: 600;
  word-break: break-word;
}
.tx-selection-x {
  flex-shrink: 0;
}
.tx-selection-purpose {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}

/* ── Filter panel (expands below the sticky tx-header) ────────────── */
.tx-filter-panel {
  position: sticky;
  top: 130px;
  z-index: 1;
}
.tx-filter-panel {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  padding: 0.6rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
}
.tx-filter-fields {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
}
.tx-filter-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.tx-filter-input {
  width: 100%;
  min-width: 0;
}
.tx-filter-actions {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: stretch;
}
.tx-filter-actions :deep(.p-button) {
  min-width: 2.5rem;
  height: 2.5rem;
}
.tx-header > :first-child {
  grid-area: back;
}
.tx-header-title {
  grid-area: title;
  min-width: 0;
}
.tx-header-title h1 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tx-header-meta {
  grid-area: meta;
  display: flex;
  flex-direction: column;
  font-variant-numeric: tabular-nums;
  font-size: 0.85rem;
  opacity: 0.95;
}
.tx-header-balance {
  font-weight: 600;
  font-size: 0.95rem;
}
.tx-header-actions {
  grid-area: actions;
  display: flex;
  gap: 0.35rem;
}

/* ── Day groups + transaction cards ───────────────────────────────── */
.tx-day {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.tx-day-header {
  margin: 0.75rem 0 0.25rem;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--p-text-color);
}
.tx-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.tx-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: background 0.1s, box-shadow 0.1s;
}
.tx-card:hover {
  background: var(--p-content-hover-background);
}
.tx-card-selected {
  background: var(--p-highlight-background);
  border-color: var(--p-primary-color);
}
.tx-card-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  flex: 1;
}
.tx-counterparty {
  font-weight: 700;
  word-break: break-word;
}
.tx-purpose {
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
.tx-notice {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  font-style: italic;
  word-break: break-word;
}
.tx-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.35rem;
}
.tx-amount {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  font-weight: 600;
  font-size: 1rem;
}
.tx-amount-positive {
  color: var(--p-text-color);
}
.tx-amount-negative {
  color: var(--p-red-600, #c0392b);
}
.tx-amount-neutral {
  color: var(--p-text-muted-color);
}

/* ── Tag chips ────────────────────────────────────────────────────── */
/* PrimeVue Tag component CSS is lazily loaded; define the base rules
   here so spans with .p-tag classes render correctly without importing
   the Tag component. */
.tag-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--p-tag-border-radius, 4px);
  padding: var(--p-tag-padding, 0.25rem 0.5rem);
  font-size: var(--p-tag-font-size, 0.75rem);
  font-weight: var(--p-tag-font-weight, 700);
  white-space: nowrap;
  line-height: 1;
}
.p-tag-info.tag-chip {
  background: var(--p-tag-info-background, rgba(59, 130, 246, 0.15));
  color: var(--p-tag-info-color, var(--p-blue-600, #2563eb));
}
.p-tag-success.tag-chip {
  background: var(--p-tag-success-background, rgba(34, 197, 94, 0.15));
  color: var(--p-tag-success-color, var(--p-green-600, #16a34a));
}

/* ── Empty / loading / dummy states ───────────────────────────────── */
.tx-loading,
.tx-empty {
  color: var(--p-text-muted-color);
  padding: 1rem 0;
  text-align: center;
}
.tx-cap-hint {
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
  text-align: center;
  margin: 1rem 0 0;
}
.tx-dummy {
  font-size: 0.85rem;
}

/* ── Holdings table ──────────────────────────────────────────────── */

.holdings-section {
  margin-bottom: 1.5rem;
  /* Flex children default to min-width:auto (= content size). Without
     this the nowrap number cells would force the section — and the
     whole .page column — wider than the viewport on portrait. */
  min-width: 0;
}
.holdings-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.holdings-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
}
.holdings-date {
  font-weight: 400;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.holdings-table-wrap {
  /* No horizontal scroll — narrow viewports shrink the table via the
     mobile rules below (smaller font/padding, hidden share column). */
  width: 100%;
}
.holdings-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  table-layout: auto;
}
.holdings-table th {
  text-align: left;
  font-weight: 600;
  padding: 0.4rem 0.6rem;
  border-bottom: 2px solid var(--p-content-border-color);
  white-space: nowrap;
}
.holdings-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}
.holdings-table tfoot td {
  font-weight: 600;
  border-top: 2px solid var(--p-content-border-color);
  border-bottom: none;
}
.holdings-col-num {
  text-align: right !important;
  white-space: nowrap;
}
.holdings-name {
  display: block;
  font-weight: 500;
  word-break: break-word;
}
.holdings-isin {
  display: block;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.holdings-value {
  font-weight: 600;
}
.holdings-row {
  cursor: pointer;
}
.holdings-row:hover {
  background: var(--p-content-hover-background);
}
.holdings-row-expanded {
  background: var(--p-content-hover-background);
}

/* Short-label swap: "Stück" on wider screens, "Stk" on small ones. */
.thead-short {
  display: none;
}

@media (max-width: 640px) {
  .holdings-table {
    font-size: 0.78rem;
  }
  .holdings-table th,
  .holdings-table td {
    padding: 0.35rem 0.35rem;
  }
  /* "Anteil" is redundant with "Wert" on the smallest screens and is
     the first thing to drop. Hidden in head, body AND footer so the
     column collapses cleanly — no empty cells or stray "100 %" left. */
  .holdings-table .holdings-col-share {
    display: none;
  }
  /* Allow numeric cells to break onto a second line in portrait — without
     this, nowrap forces the table wider than the viewport. */
  .holdings-table .holdings-col-num {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .holdings-isin {
    font-size: 0.7rem;
    overflow-wrap: anywhere;
  }
  .thead-full {
    display: none;
  }
  .thead-short {
    display: inline;
  }
}

.holdings-history-row td {
  background: var(--p-content-hover-background);
  padding: 0.5rem 0.6rem 0.75rem;
}
.holdings-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}
.holdings-history-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.holdings-sparkline-wrap {
  height: 7rem;
}
.holdings-sparkline {
  height: 100%;
}
.holdings-history-empty {
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

/* Per-position depot transactions (Phase 2) */
.depot-tx {
  margin-top: 0.85rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--p-content-border-color);
}
.depot-tx-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.depot-tx-form {
  margin: 0.25rem 0 0.6rem;
}
.depot-tx-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: 0.5rem;
}
.depot-tx-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.depot-tx-field :deep(.p-inputtext),
.depot-tx-field :deep(.p-select),
.depot-tx-field :deep(.p-datepicker-input) {
  width: 100%;
}
.depot-tx-field-wide {
  grid-column: 1 / -1;
}
.depot-tx-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.depot-tx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
  margin-top: 0.25rem;
}
.depot-tx-table th {
  text-align: left;
  font-weight: 600;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.depot-tx-table td {
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.depot-tx-source {
  display: inline-block;
  margin-left: 0.35rem;
  font-size: 0.65rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* Depot value-over-time chart */
.depot-history-wrap {
  height: 14rem;
  margin-bottom: 1rem;
}
.depot-history-chart {
  height: 100%;
}
.depot-history-hint {
  margin: 0 0 1rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}
</style>
