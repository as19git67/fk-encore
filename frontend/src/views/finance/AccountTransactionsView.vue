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
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useTransactionsStore } from '../../stores/finance/transactions'
import { useOverviewStore } from '../../stores/finance/overview'
import type {
  OverviewAccount,
  OverviewSection,
  Transaction,
} from '../../api/finance'

const route = useRoute()
const router = useRouter()
const txStore = useTransactionsStore()
const overviewStore = useOverviewStore()

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

// ── Loading transactions ──────────────────────────────────────────────

async function loadTransactions() {
  const m = mode.value
  if (!m) return
  if (m.kind === 'account') {
    await txStore.refresh({ accountId: m.accountId, limit: PAGE_LIMIT })
    return
  }
  // Section mode — wait for the overview to know which accounts belong
  // to this section.
  const sec = resolvedSection.value
  if (!sec) {
    txStore.items = []
    txStore.total = 0
    return
  }
  const ids = sec.accounts.map((a) => a.id)
  if (ids.length === 0) {
    txStore.items = []
    txStore.total = 0
    return
  }
  await txStore.refresh({ accountIds: ids, limit: PAGE_LIMIT })
}

onMounted(async () => {
  if (!overviewStore.data) await overviewStore.refresh()
  await loadTransactions()
})

// React to route changes (navigating from one section/account to
// another without unmounting the component).
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
    toggleSelection(tx.id)
    return
  }
  void router.push({
    name: 'finance-transaction-detail',
    params: { id: tx.id },
  })
}

// ── Header icon dummies ───────────────────────────────────────────────

const filterDummyOpen = ref(false)
const selectionListDummyOpen = ref(false)
const selectMode = ref(false)
const selection = ref<Set<number>>(new Set())

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selection.value = new Set()
}
function toggleSelection(txId: number) {
  const next = new Set(selection.value)
  if (next.has(txId)) next.delete(txId)
  else next.add(txId)
  selection.value = next
}

function goBack() {
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
      <div class="tx-header-title">
        <h1>{{ headerTitle }}</h1>
      </div>
      <div class="tx-header-meta">
        <span v-if="headerBalance" class="tx-header-balance">
          {{ headerBalance }}
        </span>
        <span v-if="headerDate" class="tx-header-date">{{ headerDate }}</span>
      </div>
      <div class="tx-header-actions">
        <Button
          icon="pi pi-filter"
          severity="secondary"
          rounded
          aria-label="Filter"
          :class="{ 'tx-icon-active': filterDummyOpen }"
          @click="filterDummyOpen = !filterDummyOpen"
        />
        <Button
          icon="pi pi-list"
          severity="secondary"
          rounded
          aria-label="Liste der ausgewählten"
          :class="{ 'tx-icon-active': selectionListDummyOpen }"
          @click="selectionListDummyOpen = !selectionListDummyOpen"
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

    <Message
      v-if="filterDummyOpen"
      severity="info"
      :closable="false"
      class="tx-dummy"
    >
      Filter — Platzhalter. Die Filter-Optionen werden später ergänzt.
    </Message>
    <Message
      v-if="selectionListDummyOpen"
      severity="info"
      :closable="false"
      class="tx-dummy"
    >
      Liste der ausgewählten — Platzhalter. {{ selection.size }} Buchung(en)
      derzeit markiert.
    </Message>
    <Message
      v-if="selectMode"
      severity="info"
      :closable="false"
      class="tx-dummy"
    >
      Auswahl-Modus aktiv — Klick auf eine Buchung markiert sie statt sie zu öffnen.
    </Message>

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
              'tx-card-selected': selection.has(tx.id),
            }"
            @click="openTransaction(tx)"
          >
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
  top: 0;
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
  background: rgba(255, 255, 255, 0.4);
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
  background: var(--p-surface-0);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: background 0.1s, box-shadow 0.1s;
}
.tx-card:hover {
  background: var(--p-surface-50);
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
  background: #432649;
  color: #f3e0f8;
}
.tx-tag-ai {
  background: #4caf50;
  color: #ffffff;
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
