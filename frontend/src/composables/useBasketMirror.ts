import { watch } from 'vue'
import type { CollectionEntityType, CollectionMember, MemberRef } from '../api/collections'
import { useBasketStore } from '../stores/basket'
import type { SelectionState } from './useSelection'

/**
 * Keeps a module's own basket store in step with the shared basket (#1548).
 *
 * The transaction and document drawers compute with whole objects — sums,
 * tag tristates, recurring groups — so their stores keep holding them. What
 * is *in* the basket, though, is decided by the shared basket on the server:
 *
 *   - every change made through the module store goes to the shared basket;
 *   - whenever the shared basket's members of this type change (another tab,
 *     another device, "save as collection" emptying it), the module store
 *     drops what left and fetches what arrived, in the basket's order.
 *
 * A tab that still holds a pile from before the basket moved to the server
 * hands it over once instead of throwing it away.
 */

export interface BasketMirrorOptions<T extends { id: number }> {
  type: CollectionEntityType
  /** Load one item the module store does not hold yet. */
  fetchOne: (id: number) => Promise<T>
  /** What the shared basket shows for the item before the server answers. */
  display?: (item: T) => Partial<CollectionMember>
}

function migratedKey(type: CollectionEntityType): string {
  return `basket.handedOver.${type}.v1`
}

function readFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === '1'
  } catch {
    return true
  }
}

function writeFlag(key: string): void {
  try {
    window.sessionStorage.setItem(key, '1')
  } catch {
    // Without storage there is nothing left over to hand over either.
  }
}

export function useBasketMirror<T extends { id: number }>(
  selection: SelectionState<T>,
  opts: BasketMirrorOptions<T>,
): SelectionState<T> & { addAll: (items: T[]) => void } {
  const basket = useBasketStore()
  const toRef = (id: number): MemberRef => ({ entity_type: opts.type, entity_id: id })
  const withDisplay = (item: T) => ({ ...toRef(item.id), display: opts.display?.(item) })

  function add(item: T) {
    if (selection.has(item.id)) return
    selection.add(item)
    basket.add([withDisplay(item)])
  }
  function addAll(items: T[]) {
    const fresh = items.filter((item) => !selection.has(item.id))
    if (fresh.length === 0) return
    selection.set([...selection.items.value, ...fresh])
    basket.add(fresh.map(withDisplay))
  }
  function remove(id: number) {
    if (!selection.has(id)) return
    selection.remove(id)
    basket.remove([toRef(id)])
  }
  function toggle(item: T) {
    if (selection.has(item.id)) remove(item.id)
    else add(item)
  }
  function set(next: T[]) {
    const nextIds = new Set(next.map((item) => item.id))
    const gone = selection.items.value.filter((item) => !nextIds.has(item.id)).map((item) => toRef(item.id))
    const fresh = next.filter((item) => !selection.has(item.id))
    selection.set(next)
    if (gone.length) basket.remove(gone)
    if (fresh.length) basket.add(fresh.map(withDisplay))
  }
  function clear() {
    if (selection.count.value === 0) return
    selection.clear()
    void basket.clear(opts.type)
  }

  let generation = 0
  async function reconcile() {
    const run = ++generation
    const serverIds = basket.idsOf(opts.type)
    const server = new Set(serverIds)

    const flag = migratedKey(opts.type)
    if (!readFlag(flag)) {
      writeFlag(flag)
      const leftover = selection.items.value.filter((item) => !server.has(item.id))
      if (leftover.length) {
        basket.add(leftover.map(withDisplay))
        return
      }
    }

    const held = new Map(selection.items.value.map((item) => [item.id, item]))
    const missing = serverIds.filter((id) => !held.has(id))
    if (missing.length) {
      const fetched = await Promise.allSettled(missing.map((id) => opts.fetchOne(id)))
      if (run !== generation) return
      fetched.forEach((result) => {
        if (result.status === 'fulfilled') held.set(result.value.id, result.value)
      })
    }
    // Keep the order the module gave its pile (a drawer may sort it); what
    // arrived from elsewhere follows in the basket's order.
    const now = new Set(basket.idsOf(opts.type))
    const kept = selection.items.value.filter((item) => now.has(item.id))
    const keptIds = new Set(kept.map((item) => item.id))
    const arrived = basket
      .idsOf(opts.type)
      .filter((id) => !keptIds.has(id))
      .map((id) => held.get(id))
      .filter((item): item is T => !!item)
    const ordered = [...kept, ...arrived]
    const same =
      ordered.length === selection.items.value.length &&
      ordered.every((item, i) => selection.items.value[i]?.id === item.id)
    if (!same) selection.set(ordered)
  }

  watch(
    () => (basket.loaded ? basket.idsOf(opts.type).join(',') : null),
    (signature) => {
      if (signature !== null) void reconcile()
    },
    { immediate: true },
  )

  return { ...selection, add, addAll, remove, toggle, set, clear }
}
