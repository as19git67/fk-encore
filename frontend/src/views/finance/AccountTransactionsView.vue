<script setup lang="ts">
/**
 * Buchungsliste — entweder für ein einzelnes Konto (`/finanzen/uebersicht/konto/:id`)
 * oder für alle Konten einer Sektion (`/finanzen/uebersicht/sektion/:name`).
 *
 * Liefert die 500 neuesten Buchungen ohne Pagination — für ältere
 * Datensätze ist Suche / Filter vorgesehen (Filter-Icon oben rechts;
 * Logik folgt später, derzeit Dummy).
 */

import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useScrollRestore } from '../../composables/useScrollRestore'
import Button from 'primevue/button'
import Message from 'primevue/message'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import Checkbox from 'primevue/checkbox'
import Popover from 'primevue/popover'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useOverviewStore } from '../../stores/finance/overview'
import { useTagsStore } from '../../stores/finance/tags'
import { useTxSelectionStore } from '../../stores/finance/selection'
import { useTxFiltersStore } from '../../stores/finance/txFilters'
import DateRangePresets from '../../components/DateRangePresets.vue'
import type {
  ListTransactionsQuery,
  OverviewAccount,
  OverviewSection,
  Transaction,
} from '../../api/finance'

const route = useRoute()
const router = useRouter()
const txStore = useTransactionsStore()
const overviewStore = useOverviewStore()
const tagsStore = useTagsStore()
const { restore: restoreScroll } = useScrollRestore('finance-transactions')
const selectionStore = useTxSelectionStore()
const filtersStore = useTxFiltersStore()

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
// Persisted in useTxFiltersStore so that navigating to BatchTagView
// and back does not reset the user's search criteria.

const filterPanelOpen = ref(false)
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
    selectionStore.toggle(tx)
    return
  }
  void router.push({
    name: 'finance-transaction-detail',
    params: { id: tx.id },
  })
}

// ── Select mode + multi-selection state ───────────────────────────────

const selectMode = ref(selectionStore.count > 0)
const selectionPopover = ref<InstanceType<typeof Popover> | null>(null)

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) {
    selectionStore.clear()
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
    selectionStore.has(tx.id),
  ).length
  if (selectedCount === 0) return false
  if (selectedCount === visibleCount && visibleCount > 0) return true
  return null
})

function toggleSelectAll(checked: boolean | null) {
  // PrimeVue's binary checkbox emits true/false; we never expect null
  // here. Treat anything truthy as "select all visible", else clear.
  if (checked) {
    selectionStore.set(txStore.items)
  } else {
    selectionStore.clear()
  }
}

function clearSelection() {
  selectionStore.clear()
  selectionPopover.value?.hide()
  selectMode.value = false
}

function openSelectionPopover(event: Event) {
  if (selectionStore.count === 0) return
  selectionPopover.value?.toggle(event)
}

function formatSelectionSum(): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: selectionStore.currency,
  }).format(selectionStore.sum)
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

function openBatchTagEditor() {
  if (selectionStore.count === 0) return
  selectionPopover.value?.hide()
  void router.push({ name: 'finance-batch-tag' })
}

function goBack() {
  if (selectMode.value) {
    // Leaving select mode is the more useful action than navigating
    // away when the user expects "Zurück" → list-without-selection.
    selectMode.value = false
    selectionStore.clear()
    return
  }
  if (window.history.length > 1) router.back()
  else void router.push({ name: 'finance-overview' })
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
            {{ selectionStore.count }} Buchung{{ selectionStore.count === 1 ? '' : 'en' }}
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
      <div class="tx-header-actions">
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
          :disabled="!selectMode || selectionStore.count === 0"
          :class="{ 'tx-icon-active': selectMode && selectionStore.count > 0 }"
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
          v-for="tx in selectionStore.items"
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
              @click="selectionStore.remove(tx.id)"
            />
          </div>
        </li>
      </ul>
    </Popover>

    <!--
      Tristate "select all" + batch action row, only in select mode.
    -->
    <div v-if="selectMode" class="tx-select-bar">
      <div class="tx-select-bar-left">
        <Checkbox
          :model-value="selectAllState === true"
          :indeterminate="selectAllState === null"
          :binary="true"
          aria-label="Alle Buchungen auswählen"
          @update:model-value="toggleSelectAll"
        />
        <span class="tx-select-count">
          {{ selectionStore.count }} ausgewählt
        </span>
      </div>
      <div class="tx-select-bar-actions">
        <Button
            icon="pi pi-tag"
            severity="secondary"
            aria-label="Tags auf Auswahl anwenden"
            :disabled="selectionStore.count === 0"
            @click="openBatchTagEditor"
        />
        <Button
            icon="pi pi-times"
            severity="secondary"
            aria-label="Nichts auswählen"
            :disabled="selectionStore.count === 0"
            @click="clearSelection"
        />
      </div>
    </div>

    <section
      v-if="filterPanelOpen"
      class="tx-filter-panel"
      :class="{ 'tx-filter-panel--below-select-bar': selectMode }"
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
            @click="formQuery = ''"
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

    <Message v-if="txStore.error" severity="error" :closable="false">
      {{ txStore.error }}
    </Message>

    <div v-if="txStore.loading" class="tx-loading">Lädt …</div>

    <div
      v-else-if="groupedTransactions.length === 0"
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
              'tx-card-selected': selectionStore.has(tx.id),
              'tx-card-select-mode': selectMode,
            }"
            @click="openTransaction(tx)"
          >
            <div v-if="selectMode" class="tx-card-lead" @click.stop>
              <Checkbox
                :model-value="selectionStore.has(tx.id)"
                :binary="true"
                aria-label="Buchung auswählen"
                @update:model-value="selectionStore.toggle(tx)"
              />
            </div>
            <div class="tx-card-body">
              <div class="tx-counterparty">
                {{ tx.counterparty || '(ohne Gegenseite)' }}
              </div>
              <div v-if="tx.purpose" class="tx-purpose">
                {{ tx.purpose }}
              </div>
              <div v-if="tx.tags.length > 0" class="tx-tags">
                <span
                  v-for="t in tx.tags"
                  :key="t.name + t.source"
                  class="tx-tag"
                  :class="`tx-tag-${t.source}`"
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
  grid-template-columns: auto 1fr auto;
  grid-template-areas:
    'back title actions'
    'back meta  actions';
  align-items: center;
  gap: 0.5rem 0.75rem;
  background: var(--p-primary-700, #1f6e3a);
  color: var(--p-primary-contrast-color, #fff);
  padding: 0.6rem 0.75rem;
  border-radius: 0.5rem;
  position: sticky;
  top: 58px;
  z-index: 1;
}
.tx-header :deep(.p-button) {
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid transparent;
  color: var(--p-primary-contrast-color, #fff);
}
.tx-header :deep(.p-button:hover) {
  background: rgba(255, 255, 255, 0.3);
}
.tx-header :deep(.p-button.tx-icon-active) {
  background: var(--p-orange-500, #f97316);
  color: #fff;
}
.tx-header :deep(.p-button.tx-icon-applied) {
  background: var(--p-orange-500, #f97316);
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

/* ── Filter panel (expands below the sticky header) ───────────────── */
.tx-filter-panel {
  position: sticky;
  top: 3.4rem;
  z-index: 1;
}
/* When the select-bar is also visible it stacks above the filter
   panel — shift the filter panel down by the select-bar height. */
.tx-filter-panel--below-select-bar {
  top: 6.2rem;
}
@media (max-width: 480px) {
  .tx-filter-panel--below-select-bar {
    top: 6rem;
  }
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
@media (max-width: 480px) {
  .tx-filter-panel {
    top: 3.2rem;
  }
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
  background: var(--p-primary-50, #fff7e0);
  border-color: var(--p-primary-300, #e0b864);
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
  white-space: pre-wrap;
  word-break: break-word;
}
.tx-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.35rem;
}
.tx-tag {
  display: inline-flex;
  align-items: center;
  padding: 0.18rem 0.6rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  line-height: 1.1;
}
.tx-tag-user {
  background: var(--p-tag-info-background);
  color: var(--p-tag-info-color);
}
.tx-tag-ai {
  background: var(--p-tag-success-background);
  color: var(--p-tag-success-color);
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
</style>
