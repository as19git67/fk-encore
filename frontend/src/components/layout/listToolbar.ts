import type { ComputedRef, Ref } from 'vue'
import type { UseSortReturn } from '../../composables/useSort'

/**
 * The contract between a list view and the shared `ListToolbar`
 * (issue #1272, stage 3; concept §3).
 *
 * Every list hands the toolbar the same small model, so search, filter
 * chips, sort, the result count, the view switcher and the select-mode
 * toggle look and behave identically everywhere. The domain-specific parts
 * — what a filter *is*, how it is queried — stay in the view's own
 * composable (`useFilter`, `useDocumentFilter`, …); only the shape shown in
 * the toolbar is unified.
 */

/** One removable summary of an applied filter criterion. */
export interface FilterChip {
  /** Stable identity, used as the render key. */
  key: string
  label: string
  /** Clear exactly this criterion. */
  remove: () => void
}

/** One entry of the view switcher (tiles/list, grouping, …). */
export interface ViewOption {
  value: string
  label: string
  icon?: string
}

export interface ListToolbarSearch {
  /** Bound to the input; mirrored to `?q=` after a short debounce. */
  value: Ref<string>
  placeholder: string
}

export interface ListToolbarFilter {
  chips: ComputedRef<FilterChip[]>
  activeCount: ComputedRef<number>
  /** Open the view's own filter menu, anchored at the event's target. */
  open: (event: Event) => void
  clearAll: () => void
}

export interface ListToolbarResult {
  /** How many rows the list currently shows. */
  loaded: ComputedRef<number>
  /** How many exist in total; `undefined` when the backend gives no count. */
  total: ComputedRef<number | undefined>
  loading: ComputedRef<boolean>
}

export interface ListToolbarView {
  options: ViewOption[]
  value: Ref<string>
}

export interface ListToolbarSelection {
  active: Ref<boolean>
  toggle: () => void
}

export interface ListToolbarModel {
  /**
   * Optional: a few lists (jobs, roles) have nothing to search. The concept
   * lists `search` as required; making it optional keeps those lists on the
   * same toolbar instead of forcing a second layout.
   */
  search?: ListToolbarSearch
  filter?: ListToolbarFilter
  sort?: UseSortReturn
  result: ListToolbarResult
  view?: ListToolbarView
  selection?: ListToolbarSelection
}

const numberFormat = new Intl.NumberFormat('de-DE')

export function formatCount(n: number): string {
  return numberFormat.format(n)
}

/**
 * The one wording for "how many rows am I looking at".
 *
 * - nothing found → "Keine Treffer"
 * - everything loaded (or no total known) → "{n} Treffer"
 * - partially loaded of a known total → "{loaded} von {total}"
 *
 * The concept writes the middle case as "{loaded} von {total}" throughout;
 * collapsing it to "{n} Treffer" once the list is complete avoids the
 * "12 von 12" that reads like something is still missing.
 */
export function formatResultCount(loaded: number, total?: number): string {
  if (total === undefined) {
    return loaded === 0 ? 'Keine Treffer' : `${formatCount(loaded)} Treffer`
  }
  if (total === 0) return 'Keine Treffer'
  if (loaded >= total) return `${formatCount(total)} Treffer`
  return `${formatCount(loaded)} von ${formatCount(total)}`
}

/**
 * Whether a keydown should be taken as the global "/ focuses the search"
 * shortcut. Typing a slash into any text entry must stay a slash.
 */
export function isSearchHotkey(event: KeyboardEvent): boolean {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return false
  const el = event.target as HTMLElement | null
  if (!el) return true
  if (el.isContentEditable) return false
  const tag = el.tagName
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'
}
