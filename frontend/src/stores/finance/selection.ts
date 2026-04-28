import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Transaction } from '../../api/finance'

/**
 * Holds the user's current multi-select on the transaction list so
 * sibling views — the selection popup, the Tags-für-N-Buchungen
 * editor — can read it without route-param round-trips.
 *
 * Items are full Transaction objects (not just ids) so the batch-tag
 * editor can compute the per-tag tristate state from existing tags
 * without having to refetch.
 */
export const useTxSelectionStore = defineStore('finance.txSelection', () => {
  const items = ref<Transaction[]>([])

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

  return { items, ids, count, sum, currency, set, add, remove, toggle, clear, has }
})
