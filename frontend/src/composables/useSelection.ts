import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'

/**
 * Generic multi-select state with optional sessionStorage persistence.
 *
 * Drives the finance basket (`useTxSelectionStore`) and is intentionally
 * domain-agnostic — anything with an `id` can be selected. Items are
 * held as full objects, not just ids, so consumers (e.g. the batch-tag
 * editor) can derive tristate from nested fields without a refetch.
 *
 * Persistence: when `storageKey` is set the selection is read from
 * `sessionStorage` on creation and rewritten on every mutation. Quota /
 * private-mode failures are swallowed so the in-memory state stays
 * usable. Stored payload is versioned (`{ version: 1, items }`) so a
 * future schema change can drop incompatible entries.
 */

interface StoredPayload<T> {
  version: 1
  items: T[]
}

export interface SelectionState<T extends { id: number | string }> {
  items: Ref<T[]>
  ids: ComputedRef<Array<T['id']>>
  count: ComputedRef<number>
  add: (item: T) => void
  remove: (id: T['id']) => void
  toggle: (item: T) => void
  set: (items: T[]) => void
  clear: () => void
  has: (id: T['id']) => boolean
}

export interface UseSelectionOptions {
  /** sessionStorage key; when omitted the selection lives only in memory. */
  storageKey?: string
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.sessionStorage
}

function loadFromStorage<T extends { id: number | string }>(
  storageKey: string,
): T[] {
  if (!hasStorage()) return []
  try {
    const raw = window.sessionStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<StoredPayload<T>>
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return []
    return parsed.items.filter((t): t is T => {
      if (!t || typeof t !== 'object') return false
      const id = (t as T).id
      return typeof id === 'number' || typeof id === 'string'
    })
  } catch {
    return []
  }
}

function saveToStorage<T>(storageKey: string, items: T[]): void {
  if (!hasStorage()) return
  try {
    if (items.length === 0) {
      window.sessionStorage.removeItem(storageKey)
      return
    }
    const payload: StoredPayload<T> = { version: 1, items }
    window.sessionStorage.setItem(storageKey, JSON.stringify(payload))
  } catch {
    // Quota exceeded, storage disabled, or serialization failure —
    // fail silently so the in-memory state stays consistent.
  }
}

export function useSelection<T extends { id: number | string }>(
  opts: UseSelectionOptions = {},
): SelectionState<T> {
  const { storageKey } = opts

  const initial = storageKey ? loadFromStorage<T>(storageKey) : []
  const items = ref(initial) as Ref<T[]>

  const ids = computed(() => items.value.map((t) => t.id))
  const count = computed(() => items.value.length)

  function add(item: T) {
    if (items.value.some((t) => t.id === item.id)) return
    items.value = [...items.value, item]
  }
  function remove(id: T['id']) {
    items.value = items.value.filter((t) => t.id !== id)
  }
  function toggle(item: T) {
    if (items.value.some((t) => t.id === item.id)) remove(item.id)
    else add(item)
  }
  function set(next: T[]) {
    items.value = [...next]
  }
  function clear() {
    items.value = []
  }
  function has(id: T['id']): boolean {
    return items.value.some((t) => t.id === id)
  }

  if (storageKey) {
    // `deep: true` because items can carry nested arrays (e.g. tags on
    // a Transaction) that mutate without replacing items.value wholesale.
    watch(items, (next) => saveToStorage(storageKey, next), { deep: true })
  }

  return { items, ids, count, add, remove, toggle, set, clear, has }
}
