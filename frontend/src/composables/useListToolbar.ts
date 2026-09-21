import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { replaceQuerySlice, updateRouteQuery } from '../utils/routeQueryUpdate'
import type {
  FilterChip,
  ListToolbarFilter,
  ListToolbarModel,
  ListToolbarSearch,
  ListToolbarSelection,
  ListToolbarView,
  ViewOption,
} from '../components/layout/listToolbar'
import type { UseSortReturn } from './useSort'

export type {
  FilterChip,
  ListToolbarFilter,
  ListToolbarModel,
  ListToolbarSearch,
  ListToolbarSelection,
  ListToolbarView,
  ViewOption,
}

/** Either a ref/computed or a plain getter — views may hand over whichever they have. */
type Source<T> = Ref<T> | ComputedRef<T> | (() => T)

function toComputed<T>(source: Source<T>): ComputedRef<T> {
  return typeof source === 'function'
    ? computed(source as () => T)
    : computed(() => source.value)
}

export interface UseListSearchOptions {
  /** Placeholder of the search input. */
  placeholder: string
  /** Query key the term is mirrored to. Defaults to `q`. */
  key?: string
  /** How long typing settles before the URL is written. Defaults to 300 ms. */
  debounceMs?: number
  /**
   * Remember the last term under this key and restore it when the list is
   * entered without a query. sessionStorage, not localStorage: a search is a
   * "what I was just doing", not a setting that should greet the user again
   * the next day.
   */
  storageKey?: string
  /**
   * Commit only when `submit()` is called, not while typing. For searches
   * that cost a backend round trip per run — the gallery's natural-language
   * search — where every keystroke would be a query.
   */
  manual?: boolean
}

export interface UseListSearchReturn extends ListToolbarSearch {
  /** Raw input value — changes on every keystroke. */
  value: Ref<string>
  /** The settled, URL-mirrored term. Fetch with this, never with `value`. */
  term: Readonly<Ref<string>>
  /** Commit the current input now (Enter, or the search button). */
  submit: () => void
  /** Drop the term now, without waiting for the debounce. */
  clear: () => void
}

function readStored(key: string | undefined): string {
  if (!key) return ''
  try {
    return sessionStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStored(key: string | undefined, value: string) {
  if (!key) return
  try {
    if (value) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  } catch {
    /* private mode — the URL still carries the term */
  }
}

/**
 * The search half of the toolbar contract: one term, debounced into the URL.
 *
 * The URL is the single source of truth (concept §3), so a reload, a deep
 * link and browser back/forward all reproduce the same list. Typing only
 * touches `value`; `term` — and with it the query the view runs — follows
 * once typing settles.
 */
export function useListSearch(options: UseListSearchOptions): UseListSearchReturn {
  const route = useRoute()
  const router = useRouter()
  const key = options.key ?? 'q'
  const debounceMs = options.debounceMs ?? 300

  const queryValue = route.query[key]
  const fromQuery = typeof queryValue === 'string' ? queryValue : ''
  const initial = fromQuery || readStored(options.storageKey)

  const value = ref(initial)
  const term = ref(initial)

  // Entered without a query but with a remembered term: put it in the URL
  // right away, so what the list shows and what the URL says never diverge.
  if (!fromQuery && initial) void syncUrl(initial)
  // A term that arrived by deep link is just as much "the last one used".
  if (fromQuery) writeStored(options.storageKey, fromQuery)

  let timer: ReturnType<typeof setTimeout> | undefined

  function syncUrl(next: string) {
    return updateRouteQuery(router, (current) =>
      replaceQuerySlice(current, [key], next ? { [key]: next } : {}),
    )
  }

  function commit(next: string) {
    if (next === term.value) return
    term.value = next
    writeStored(options.storageKey, next)
    void syncUrl(next)
  }

  if (!options.manual) {
    watch(value, (raw) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        commit(raw.trim())
      }, debounceMs)
    })
  }

  // Back/forward and other navigations write the term; adopt it verbatim.
  // Leaving the list entirely (opening a row) also changes the route, and
  // that must not be read as "the user cleared the search" — it would drop
  // the remembered term and fire one more query on the way out.
  const ownPath = route.path
  watch(
    () => [route.path, route.query[key]] as const,
    ([path, q]) => {
      if (path !== ownPath) return
      const next = typeof q === 'string' ? q : ''
      if (next === term.value) return
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      term.value = next
      value.value = next
      writeStored(options.storageKey, next)
    },
  )

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  function submit() {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    commit(value.value.trim())
  }

  function clear() {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    value.value = ''
    commit('')
  }

  return {
    value,
    term,
    placeholder: options.placeholder,
    submit,
    clear,
  }
}

export interface UseListViewOptions {
  options: ViewOption[]
  /** The option in force when neither URL nor storage says otherwise. */
  defaultValue: string
  /** Query key the choice is mirrored to. Defaults to `view`. */
  key?: string
  /** Remember the choice across visits (localStorage — this one is a setting). */
  storageKey?: string
}

/**
 * The view switcher's state: in the URL, so a shared link opens the same
 * way it looked, and optionally remembered as the user's own default.
 */
export function useListView(options: UseListViewOptions): ListToolbarView {
  const route = useRoute()
  const router = useRouter()
  const key = options.key ?? 'view'
  const known = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && options.options.some((o) => o.value === candidate)

  function stored(): string | null {
    if (!options.storageKey) return null
    try {
      const raw = localStorage.getItem(options.storageKey)
      return known(raw) ? raw : null
    } catch {
      return null
    }
  }

  const fromQuery = route.query[key]
  const initial = known(fromQuery) ? fromQuery : (stored() ?? options.defaultValue)
  const value = ref(initial)

  if (!known(fromQuery) && initial !== options.defaultValue) void syncUrl(initial)

  function syncUrl(next: string) {
    return updateRouteQuery(router, (current) =>
      replaceQuerySlice(current, [key], next === options.defaultValue ? {} : { [key]: next }),
    )
  }

  watch(value, (next) => {
    if (options.storageKey) {
      try { localStorage.setItem(options.storageKey, next) } catch { /* ignore */ }
    }
    void syncUrl(next)
  })

  // Same guard as the search: a navigation away from the list is not the
  // user switching back to the default view.
  const ownPath = route.path
  watch(
    () => [route.path, route.query[key]] as const,
    ([path, q]) => {
      if (path !== ownPath) return
      const next = known(q) ? q : options.defaultValue
      if (next !== value.value) value.value = next
    },
  )

  return { options: options.options, value }
}

export interface ListToolbarParts {
  search?: ListToolbarSearch
  filter?: {
    chips: Source<FilterChip[]>
    activeCount: Source<number>
    /** Omit when the list has no filter menu; then no filter button appears. */
    open?: (event: Event) => void
    /** Whether a filter panel that stays open is showing — see ListToolbarFilter. */
    expanded?: Source<boolean>
    clearAll: () => void
  }
  sort?: UseSortReturn
  result: {
    loaded: Source<number>
    /** Omit when the backend reports no total. */
    total?: Source<number | undefined>
    loading: Source<boolean>
  }
  view?: ListToolbarView
  selection?: ListToolbarSelection
}

/**
 * Assemble the model `ListToolbar` renders. Accepts refs or getters for the
 * counts so a view can pass `() => rows.length` without wrapping it first.
 */
export function useListToolbar(parts: ListToolbarParts): ListToolbarModel {
  const filter: ListToolbarFilter | undefined = parts.filter
    ? {
        chips: toComputed(parts.filter.chips),
        activeCount: toComputed(parts.filter.activeCount),
        open: parts.filter.open,
        expanded: parts.filter.expanded ? toComputed(parts.filter.expanded) : undefined,
        clearAll: parts.filter.clearAll,
      }
    : undefined

  return {
    search: parts.search,
    filter,
    sort: parts.sort,
    result: {
      loaded: toComputed(parts.result.loaded),
      total: parts.result.total ? toComputed(parts.result.total) : computed(() => undefined),
      loading: toComputed(parts.result.loading),
    },
    view: parts.view,
    selection: parts.selection,
  }
}
