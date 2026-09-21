import { describe, it, expect } from 'vitest'
import { ref, computed } from 'vue'
import { useBasketNavigation } from './useBasketNavigation'

interface Row {
  id: number
}

function basket(ids: number[]) {
  const items = ref<Row[]>(ids.map((id) => ({ id })))
  const current = ref<number | null>(ids[0] ?? null)
  return { items, current, nav: useBasketNavigation(items, current) }
}

describe('useBasketNavigation', () => {
  it('says where in the pile the open row is', () => {
    const { current, nav } = basket([7, 8, 9])
    current.value = 8
    expect(nav.position.value).toBe(2)
    expect(nav.total.value).toBe(3)
    expect(nav.inBasket.value).toBe(true)
  })

  it('has no neighbours at the ends', () => {
    const { current, nav } = basket([7, 8, 9])
    current.value = 7
    expect(nav.previous.value).toBeNull()
    expect(nav.next.value).toEqual({ id: 8 })
    current.value = 9
    expect(nav.previous.value).toEqual({ id: 8 })
    expect(nav.next.value).toBeNull()
  })

  it('reports a row that is not in the basket', () => {
    const { current, nav } = basket([7, 8])
    current.value = 42
    expect(nav.inBasket.value).toBe(false)
    expect(nav.index.value).toBe(-1)
    expect(nav.position.value).toBe(0)
    expect(nav.previous.value).toBeNull()
    expect(nav.next.value).toBeNull()
  })

  it('follows the basket when it changes underneath', () => {
    const { items, current, nav } = basket([7, 8, 9])
    current.value = 9
    expect(nav.position.value).toBe(3)
    // Someone removed the first one — from the drawer, or another tab.
    items.value = [{ id: 8 }, { id: 9 }]
    expect(nav.position.value).toBe(2)
    expect(nav.total.value).toBe(2)
    // And then emptied it.
    items.value = []
    expect(nav.inBasket.value).toBe(false)
    expect(nav.total.value).toBe(0)
  })

  it('handles a detail page opened without an id yet', () => {
    const items = ref<Row[]>([{ id: 1 }])
    const nav = useBasketNavigation(
      items,
      computed(() => null),
    )
    expect(nav.index.value).toBe(-1)
    expect(nav.inBasket.value).toBe(false)
  })
})
