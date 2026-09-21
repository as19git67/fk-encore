import { computed, type ComputedRef, type Ref } from 'vue'

/**
 * Stepping through a basket from a detail page (issue #1272, stage 5).
 *
 * Putting a handful of documents or transactions aside and then working
 * through them one by one is the point of the basket, so the detail page
 * needs to know where in the pile it is. The document detail view worked
 * this out inline; the transaction detail view had no way forward at all
 * although its basket is just as ordered. Both ask here now.
 *
 * The position is derived, never stored: the basket can be added to or
 * emptied from anywhere (the drawer, another tab's list), and a remembered
 * index would be wrong the moment it is.
 */

export interface BasketItem {
  id: number
}

export interface UseBasketNavigationReturn<T extends BasketItem> {
  /** Position in the basket, or -1 when this row is not in it. */
  index: ComputedRef<number>
  /** Whether the row currently open is in the basket. */
  inBasket: ComputedRef<boolean>
  /** Human position, 1-based: "3 / 7". Zero when not in the basket. */
  position: ComputedRef<number>
  total: ComputedRef<number>
  previous: ComputedRef<T | null>
  next: ComputedRef<T | null>
}

export function useBasketNavigation<T extends BasketItem>(
  items: Ref<T[]> | ComputedRef<T[]>,
  currentId: Ref<number | null> | ComputedRef<number | null>,
): UseBasketNavigationReturn<T> {
  const index = computed(() => {
    const id = currentId.value
    return id === null ? -1 : items.value.findIndex((item) => item.id === id)
  })

  const total = computed(() => items.value.length)
  const inBasket = computed(() => index.value >= 0)
  const position = computed(() => (index.value >= 0 ? index.value + 1 : 0))

  const previous = computed(() => (index.value > 0 ? items.value[index.value - 1] ?? null : null))
  const next = computed(() =>
    index.value >= 0 && index.value < total.value - 1 ? items.value[index.value + 1] ?? null : null,
  )

  return { index, inBasket, position, total, previous, next }
}
