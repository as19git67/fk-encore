import { defineStore } from 'pinia'
import { computed } from 'vue'
import type { Transaction } from '../../api/finance'
import { useSelection } from '../../composables/useSelection'

/**
 * Finance-specific selection: holds the user's transaction basket so
 * sibling views (selection popup, batch-tag editor, basket drawer) can
 * read it without route-param round-trips.
 *
 * The set operations + sessionStorage persistence live in the generic
 * useSelection<T> composable. Domain-specific aggregates (running sum,
 * display currency) stay here because they only make sense for
 * transactions.
 */

export const useTxSelectionStore = defineStore('finance.txSelection', () => {
  const selection = useSelection<Transaction>({
    storageKey: 'finance.txSelection.v1',
    isValidItem: (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as Transaction).id === 'number',
  })

  const sum = computed(() =>
    selection.items.value.reduce((acc, t) => acc + Number(t.amount || 0), 0),
  )
  /** Currency of the first item — used for the header sum display.
   *  Mixed-currency selections are rare in practice (a user usually
   *  works on one account at a time); the first one is good enough
   *  for a header label. */
  const currency = computed(
    () => selection.items.value[0]?.currency_code ?? 'EUR',
  )

  return {
    items: selection.items,
    ids: selection.ids,
    count: selection.count,
    add: selection.add,
    remove: selection.remove,
    toggle: selection.toggle,
    set: selection.set,
    clear: selection.clear,
    has: selection.has,
    sum,
    currency,
  }
})
