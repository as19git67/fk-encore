import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { replaceQuerySlice, updateRouteQuery } from '../utils/routeQueryUpdate'

/**
 * Sort composable with draft/applied semantics and URL query-string sync.
 *
 * Mirrors `useFilter`: the menu edits `draft`; `applied` is only written when
 * the user presses "Anwenden" / "Zurücksetzen". Sort state is spiegeled to
 * the URL via `?sortBy=…&sortDir=…` (omitted when equal to the view default).
 */

export type SortDirection = 'asc' | 'desc'
export interface SortState {
  field: string
  direction: SortDirection
}
export interface SortField {
  value: string
  label: string
}

export interface UseSortOptions {
  fields: SortField[]
  defaultState: SortState
  storageKey?: string
}

export interface UseSortReturn {
  applied: Ref<SortState>
  draft: Ref<SortState>
  /** True when the applied sort matches the configured default. */
  isDefault: Ref<boolean>
  /** Human label of the applied field (from `fields`). */
  fieldLabel: Ref<string>
  /** Copy applied into draft (open the menu). */
  openEdit: () => void
  /** Apply the draft and sync to URL. */
  apply: () => void
  /** Reset to the default and sync to URL. */
  reset: () => void
}

const SORT_QUERY_KEYS = ['sortBy', 'sortDir'] as const

export function useSort(opts: UseSortOptions): UseSortReturn {
  const route = useRoute()
  const router = useRouter()

  function parseFromQuery(q: Record<string, unknown>): SortState {
    const field = typeof q.sortBy === 'string' && opts.fields.some((f) => f.value === q.sortBy)
      ? q.sortBy
      : opts.defaultState.field
    const dir: SortDirection = q.sortDir === 'asc' || q.sortDir === 'desc'
      ? q.sortDir
      : opts.defaultState.direction
    return { field, direction: dir }
  }

  function loadStored(): SortState | null {
    if (!opts.storageKey) return null
    try {
      const raw = localStorage.getItem(opts.storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as SortState
      if (opts.fields.some((f) => f.value === parsed.field) &&
          (parsed.direction === 'asc' || parsed.direction === 'desc')) {
        return parsed
      }
    } catch { /* ignore */ }
    return null
  }

  function saveSort(s: SortState) {
    if (!opts.storageKey) return
    try { localStorage.setItem(opts.storageKey, JSON.stringify(s)) } catch { /* ignore */ }
  }

  const fromQuery = parseFromQuery(route.query as Record<string, unknown>)
  const hasQuerySort = route.query.sortBy !== undefined
  const initial = hasQuerySort ? fromQuery : (loadStored() ?? fromQuery)

  const applied = ref<SortState>(initial)
  const draft = ref<SortState>({ ...applied.value })

  if (!hasQuerySort && (initial.field !== opts.defaultState.field || initial.direction !== opts.defaultState.direction)) {
    void syncUrl(initial)
  }

  const isDefault = computed(() =>
    applied.value.field === opts.defaultState.field &&
    applied.value.direction === opts.defaultState.direction
  )

  const fieldLabel = computed(() =>
    opts.fields.find((f) => f.value === applied.value.field)?.label ?? applied.value.field
  )

  watch(
    () => route.query,
    (q) => {
      const next = parseFromQuery(q as Record<string, unknown>)
      if (next.field !== applied.value.field || next.direction !== applied.value.direction) {
        applied.value = next
      }
    }
  )

  function syncUrl(s: SortState) {
    const values: Record<string, string> = {}
    const isDef = s.field === opts.defaultState.field && s.direction === opts.defaultState.direction
    if (!isDef) {
      values.sortBy = s.field
      values.sortDir = s.direction
    }
    return updateRouteQuery(router, (current) => replaceQuerySlice(current, SORT_QUERY_KEYS, values))
  }

  function openEdit() {
    draft.value = { ...applied.value }
  }

  function apply() {
    applied.value = { ...draft.value }
    saveSort(applied.value)
    void syncUrl(applied.value)
  }

  function reset() {
    draft.value = { ...opts.defaultState }
    applied.value = { ...opts.defaultState }
    saveSort(applied.value)
    void syncUrl(applied.value)
  }

  return { applied, draft, isDefault, fieldLabel, openEdit, apply, reset }
}
