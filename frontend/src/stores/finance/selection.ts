import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Transaction } from '../../api/finance'

/**
 * Holds the user's current multi-select on the transaction list so
 * sibling views — the selection popup, the Tags-für-N-Buchungen
 * editor — can read it without route-param round-trips.
 *
 * Items are full Transaction objects (not just ids) so the batch-tag
 * editor can compute the per-tag tristate state from existing tags
 * without having to refetch.
 *
 * The selection survives a page reload via `sessionStorage` (tab-scoped):
 * the user can navigate to a transaction detail / back without losing
 * the basket. Stale-ID cleanup happens server-side on the next bulk
 * action (the batch endpoints return `skipped_unauthorized` for ids
 * the user can no longer access).
 */

const STORAGE_KEY = 'finance.txSelection.v1'

interface StoredPayload {
  version: 1
  items: Transaction[]
}

function loadFromStorage(): Transaction[] {
  if (typeof window === 'undefined' || !window.sessionStorage) return []
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<StoredPayload>
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return []
    return parsed.items.filter((t): t is Transaction =>
      !!t && typeof (t as Transaction).id === 'number',
    )
  } catch {
    return []
  }
}

function saveToStorage(items: Transaction[]): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return
  try {
    if (items.length === 0) {
      window.sessionStorage.removeItem(STORAGE_KEY)
      return
    }
    const payload: StoredPayload = { version: 1, items }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Quota exceeded, storage disabled (private mode on some browsers),
    // or serialization failure — fail silently so the in-memory store
    // stays usable.
  }
}

export const useTxSelectionStore = defineStore('finance.txSelection', () => {
  const items = ref<Transaction[]>(loadFromStorage())

  const ids = computed(() => items.value.map((t) => t.id))
  const count = computed(() => items.value.length)
  const sum = computed(() =>
    items.value.reduce((acc, t) => acc + Number(t.amount || 0), 0),
  )
  /** Currency of the first item — used for the header sum display.
   *  Mixed-currency selections are rare in practice (a user usually
   *  works on one account at a time); the first one is good enough
   *  for a header label. */
  const currency = computed(() => items.value[0]?.currency_code ?? 'EUR')

  function set(txs: Transaction[]) {
    items.value = [...txs]
  }
  function add(tx: Transaction) {
    if (items.value.some((t) => t.id === tx.id)) return
    items.value = [...items.value, tx]
  }
  function remove(id: number) {
    items.value = items.value.filter((t) => t.id !== id)
  }
  function toggle(tx: Transaction) {
    if (items.value.some((t) => t.id === tx.id)) remove(tx.id)
    else add(tx)
  }
  function clear() {
    items.value = []
  }
  function has(id: number): boolean {
    return items.value.some((t) => t.id === id)
  }

  // Persist on every change. `deep: true` because items carry nested
  // arrays (tags); without it, mutations that don't replace `items.value`
  // wholesale would slip past the watcher.
  watch(items, (next) => saveToStorage(next), { deep: true })

  return { items, ids, count, sum, currency, set, add, remove, toggle, clear, has }
})
