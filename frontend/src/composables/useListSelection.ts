/**
 * Picking several rows out of a list — one behaviour for every list
 * (issue #1272, stage 5).
 *
 * Before this, three lists each had their own: the photo grids owned a Set
 * plus a shift-anchor, the account list a hand-rolled Set that also left
 * select mode when it was cleared, and the document list permanent checkboxes
 * with no mode at all. Same gestures, three answers — and shift-range,
 * Ctrl+A and "invert" existed in at most one of them.
 *
 * What a list brings is how to reach its rows: which ids are loaded, how to
 * resolve a position (a virtual grid loads pages), and how to ask the backend
 * for every id when "select all" should mean more than the loaded page. The
 * range mechanics themselves stay in `utils/rangeSelection`.
 *
 * Leaving select mode drops the selection. It never touches a basket: the
 * selection is what the user is pointing at right now, the basket is what
 * they put aside.
 */

import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import {
  applyRange,
  collectRangeIds,
  rangeBounds,
  toggleOne,
  type SelectionAnchor,
} from '../utils/rangeSelection'

/** The least a row has to be to be selectable. */
export interface SelectableEntry {
  id: number
}

export interface ListSelectionSource {
  /** The ids the list currently shows, in display order. */
  loadedIds: () => number[]
  /**
   * Every id the list would show under its current filter. Lists that load
   * page by page use this so "select all" means the whole result, not the
   * part that happens to be on screen.
   */
  fetchAllIds?: () => Promise<number[]>
  /**
   * Resolve one position to its row, loading the page it sits on if needed.
   * Only a virtual list needs this; without it a shift-click falls back to a
   * plain toggle.
   */
  loadEntryAt?: (index: number) => Promise<SelectableEntry | null | undefined>
  /** How many rows exist in total, when the list knows more than it loaded. */
  total?: () => number | undefined
}

export interface UseListSelectionOptions extends ListSelectionSource {
  /**
   * Bind `Ctrl/Cmd+A` to "select all" while select mode is on. Off for a
   * list whose rows are always selectable (no mode), because there the
   * shortcut would fight the browser's own "select the page's text".
   */
  hotkeys?: boolean
}

export interface UseListSelectionReturn {
  /** Whether the list is in select mode. Lists without a mode leave it true. */
  selectMode: Ref<boolean>
  selectedIds: Ref<Set<number>>
  selectedCount: ComputedRef<number>
  /** Everything the list holds is selected. */
  allSelected: ComputedRef<boolean>
  /** For a tristate checkbox: all / none / some. */
  selectAllState: ComputedRef<boolean | null>
  /** A range is being resolved — a long one costs a request. */
  rangeBusy: Ref<boolean>
  /** "Select all" is in flight. */
  selectAllBusy: Ref<boolean>
  enter: () => void
  exit: () => void
  toggleMode: () => void
  /** Toggle one row; with `{ index, range }` a shift-click spans from the anchor. */
  toggle: (entry: SelectableEntry, context?: { index: number; range: boolean }) => Promise<void>
  /** Toggle by id, for a list that has no positions to span. */
  toggleId: (id: number, selected?: boolean) => void
  /** Everything, asking the backend when the list can. */
  selectAll: () => Promise<void>
  /** Only what is loaded — no request, no waiting. */
  selectAllLoaded: () => void
  /** Selected becomes unselected and the other way round, within what is loaded. */
  invert: () => void
  clear: () => void
  replace: (ids: Iterable<number>) => void
  has: (id: number) => boolean
}

export function useListSelection(options: UseListSelectionOptions): UseListSelectionReturn {
  const { loadedIds, fetchAllIds, loadEntryAt, total, hotkeys = true } = options

  const selectMode = ref(false)
  const selectedIds: Ref<Set<number>> = ref(new Set())
  const selectedCount = computed(() => selectedIds.value.size)
  /** Where the last plain click landed and what it did there. */
  const anchor = ref<SelectionAnchor | null>(null)
  const rangeBusy = ref(false)
  const selectAllBusy = ref(false)

  /** What "all" means: the whole result when the list knows its size. */
  const knownTotal = computed(() => total?.() ?? loadedIds().length)

  const allSelected = computed(
    () => knownTotal.value > 0 && selectedCount.value >= knownTotal.value,
  )

  const selectAllState = computed<boolean | null>(() => {
    if (selectedCount.value === 0) return false
    return allSelected.value ? true : null
  })

  function clear() {
    selectedIds.value = new Set()
    anchor.value = null
  }

  function replace(ids: Iterable<number>) {
    selectedIds.value = new Set(ids)
    // A wholesale replacement leaves no position a range could measure from.
    anchor.value = null
  }

  function has(id: number): boolean {
    return selectedIds.value.has(id)
  }

  function enter() {
    selectMode.value = true
    clear()
  }

  function exit() {
    selectMode.value = false
    clear()
  }

  function toggleMode() {
    if (selectMode.value) exit()
    else enter()
  }

  async function toggle(
    entry: SelectableEntry,
    context?: { index: number; range: boolean },
  ): Promise<void> {
    const from = anchor.value
    // A shift-click without an anchor — or on a list that cannot resolve
    // positions — has no span to apply and stays a plain toggle.
    if (context?.range && from && context.index >= 0 && loadEntryAt) {
      const { start, end } = rangeBounds(from.index, context.index)
      rangeBusy.value = true
      try {
        const ids = await collectRangeIds(start, end, { loadEntryAt, fetchAllIds: fetchAllIds ?? (async () => loadedIds()) })
        selectedIds.value = applyRange(selectedIds.value, ids, from.adding)
      } catch {
        // Leave the selection as it was; the click can simply be repeated.
      } finally {
        rangeBusy.value = false
      }
      // The anchor stays put, so further shift-clicks widen or narrow the
      // same span instead of walking it forward one click at a time.
      return
    }

    const { selected, adding } = toggleOne(selectedIds.value, entry.id)
    selectedIds.value = selected
    anchor.value = context && context.index >= 0 ? { index: context.index, adding } : null
  }

  function toggleId(id: number, selected?: boolean) {
    const next = new Set(selectedIds.value)
    const shouldSelect = selected ?? !next.has(id)
    if (shouldSelect) next.add(id)
    else next.delete(id)
    selectedIds.value = next
    anchor.value = null
  }

  function selectAllLoaded() {
    replace(loadedIds())
  }

  async function selectAll() {
    if (!fetchAllIds) {
      selectAllLoaded()
      return
    }
    selectAllBusy.value = true
    try {
      replace(await fetchAllIds())
    } catch {
      // Nothing selected, nothing lost: the list stays as it was and the
      // button can be pressed again.
    } finally {
      selectAllBusy.value = false
    }
  }

  function invert() {
    const next = new Set<number>()
    for (const id of loadedIds()) {
      if (!selectedIds.value.has(id)) next.add(id)
    }
    replace(next)
  }

  /**
   * `Ctrl/Cmd+A` selects everything while the list is in select mode. Inside
   * a text field it stays the browser's own "select all text".
   */
  function onKeydown(event: KeyboardEvent) {
    if (!selectMode.value) return
    if (event.key !== 'a' && event.key !== 'A') return
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    const el = event.target as HTMLElement | null
    if (el?.isContentEditable) return
    const tag = el?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    event.preventDefault()
    void selectAll()
  }

  if (hotkeys) {
    onMounted(() => document.addEventListener('keydown', onKeydown))
    onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
  }

  return {
    selectMode,
    selectedIds,
    selectedCount,
    allSelected,
    selectAllState,
    rangeBusy,
    selectAllBusy,
    enter,
    exit,
    toggleMode,
    toggle,
    toggleId,
    selectAll,
    selectAllLoaded,
    invert,
    clear,
    replace,
    has,
  }
}
