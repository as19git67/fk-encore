import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  addToBasket,
  clearBasket,
  getBasket,
  removeFromBasket,
  saveBasketAsCollection,
  type CollectionDetail,
  type CollectionEntityType,
  type CollectionMember,
  type MemberRef,
} from '../api/collections'

/**
 * The basket (issue #1548, stage 2): one per user, any type, kept on the
 * server.
 *
 * It used to be one pile per module in the tab's sessionStorage. Now it is
 * the user's unnamed collection, so a photo set aside in the gallery and a
 * transaction set aside in finance lie in the same pile, on every device.
 *
 * Changes show at once (optimistic) and go to the server in batches: a
 * "select all" of two hundred rows is one request, not two hundred. When a
 * request fails the pile is reloaded from the server, which is the truth.
 *
 * The module stores (transactions, documents) keep the full objects their
 * drawers compute with and mirror their type of this pile; see
 * `useBasketMirror`.
 */

export function memberKey(ref: MemberRef): string {
  return `${ref.entity_type}:${ref.entity_id}`
}

/** How long changes wait to be sent together. */
const FLUSH_DELAY_MS = 250

export const useBasketStore = defineStore('basket', () => {
  const members = ref<CollectionMember[]>([])
  const hiddenCount = ref(0)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  const keys = computed(() => new Set(members.value.map(memberKey)))
  const count = computed(() => members.value.length)
  const counts = computed(() => {
    const out: Partial<Record<CollectionEntityType, number>> = {}
    for (const m of members.value) out[m.entity_type] = (out[m.entity_type] ?? 0) + 1
    return out
  })

  function has(ref: MemberRef): boolean {
    return keys.value.has(memberKey(ref))
  }
  function idsOf(type: CollectionEntityType): number[] {
    return members.value.filter((m) => m.entity_type === type).map((m) => m.entity_id)
  }
  function countOf(type: CollectionEntityType): number {
    return counts.value[type] ?? 0
  }

  function apply(detail: CollectionDetail) {
    members.value = detail.members
    hiddenCount.value = detail.hidden_count
    loaded.value = true
  }

  let loading: Promise<void> | null = null
  /** Load once; later calls reuse the first answer unless `force`. */
  function load(force = false): Promise<void> {
    if (loaded.value && !force) return Promise.resolve()
    if (loading && !force) return loading
    loading = getBasket()
      .then(apply)
      .catch((err: unknown) => {
        error.value = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        loading = null
      })
    return loading
  }

  // ── Batched writes ────────────────────────────────────────────────────────

  const pendingAdd = new Map<string, MemberRef>()
  const pendingRemove = new Map<string, MemberRef>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<void> = Promise.resolve()

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, FLUSH_DELAY_MS)
  }

  /** Send what is waiting. Resolves once the server has answered. */
  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const toAdd = [...pendingAdd.values()]
    const toRemove = [...pendingRemove.values()]
    pendingAdd.clear()
    pendingRemove.clear()
    if (toAdd.length === 0 && toRemove.length === 0) return flushing
    flushing = flushing.then(async () => {
      try {
        let detail: CollectionDetail | null = null
        if (toRemove.length) detail = await removeFromBasket(toRemove)
        if (toAdd.length) detail = (await addToBasket(toAdd)).collection
        // Only take the server's pile when nothing newer is waiting, or the
        // answer would undo a change made while this request was out.
        if (detail && pendingAdd.size === 0 && pendingRemove.size === 0) apply(detail)
        error.value = null
      } catch (err: unknown) {
        error.value = err instanceof Error ? err.message : String(err)
        await load(true)
      }
    })
    return flushing
  }

  function placeholder(ref: MemberRef, display?: Partial<CollectionMember>): CollectionMember {
    return {
      title: display?.title ?? '…',
      subtitle: display?.subtitle ?? null,
      date: display?.date ?? null,
      amount: display?.amount ?? null,
      currency: display?.currency ?? null,
      joined_by: 'user',
      added_at: new Date().toISOString(),
      ...ref,
    }
  }

  /**
   * Put items in. `display` lets the caller show a proper row before the
   * server has answered (it knows the title already).
   */
  function add(refs: Array<MemberRef & { display?: Partial<CollectionMember> }>) {
    const fresh = refs.filter((r) => !keys.value.has(memberKey(r)))
    if (fresh.length === 0) return
    members.value = [...members.value, ...fresh.map((r) => placeholder({ entity_type: r.entity_type, entity_id: r.entity_id }, r.display))]
    for (const r of fresh) {
      const key = memberKey(r)
      pendingRemove.delete(key)
      pendingAdd.set(key, { entity_type: r.entity_type, entity_id: r.entity_id })
    }
    schedule()
  }

  function remove(refs: MemberRef[]) {
    const drop = new Set(refs.map(memberKey))
    if (![...drop].some((key) => keys.value.has(key))) return
    members.value = members.value.filter((m) => !drop.has(memberKey(m)))
    for (const r of refs) {
      const key = memberKey(r)
      if (pendingAdd.delete(key)) continue
      pendingRemove.set(key, { entity_type: r.entity_type, entity_id: r.entity_id })
    }
    schedule()
  }

  function toggle(ref: MemberRef & { display?: Partial<CollectionMember> }) {
    if (has(ref)) remove([ref])
    else add([ref])
  }

  /** Empty the pile, or one type of it. */
  async function clear(type?: CollectionEntityType) {
    await flush()
    members.value = type ? members.value.filter((m) => m.entity_type !== type) : []
    try {
      apply(await clearBasket(type))
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : String(err)
      await load(true)
    }
  }

  /** Name the pile: a new collection; the pile is emptied unless `keep`. */
  async function saveAs(payload: { name: string; keep?: boolean; type?: CollectionEntityType }) {
    await flush()
    const created = await saveBasketAsCollection(payload)
    await load(true)
    return created
  }

  /** Forget everything, e.g. on logout. */
  function reset() {
    if (timer) clearTimeout(timer)
    timer = null
    pendingAdd.clear()
    pendingRemove.clear()
    members.value = []
    hiddenCount.value = 0
    loaded.value = false
  }

  return {
    members,
    hiddenCount,
    loaded,
    error,
    count,
    counts,
    has,
    idsOf,
    countOf,
    load,
    flush,
    add,
    remove,
    toggle,
    clear,
    saveAs,
    reset,
  }
})
