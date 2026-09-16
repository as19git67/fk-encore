/**
 * Grid selection with shift-click range support (issue #830).
 *
 * Owns the selection Set and the anchor that a range click measures from, so
 * the gallery and the album detail view share one behaviour instead of two
 * copies of it. The range mechanics themselves live in utils/rangeSelection.
 */

import { ref, computed, type Ref } from 'vue'
import type { GalleryGridEntry } from '../api/gallery'
import {
  applyRange,
  collectRangeIds,
  rangeBounds,
  toggleOne,
  type SelectionAnchor,
} from '../utils/rangeSelection'

export interface RangeSelectSource {
  /** Resolve one grid position to its entry, loading the page if needed. */
  loadEntryAt: (index: number) => Promise<GalleryGridEntry | null | undefined>
  /** Every photo id in the current grid order — used for long ranges. */
  fetchAllIds: () => Promise<number[]>
}

export function useRangeSelect(source: RangeSelectSource) {
  const selectedIds: Ref<Set<number>> = ref(new Set())
  const selectedCount = computed(() => selectedIds.value.size)
  /** Where the last plain click landed and what it did. */
  const anchor = ref<SelectionAnchor | null>(null)
  /** True while a range is being resolved — a long one needs a request. */
  const rangeBusy = ref(false)

  /** Drop both the selection and the anchor (mode switch, explicit clear). */
  function clear() {
    selectedIds.value = new Set()
    anchor.value = null
  }

  /** Replace the selection wholesale ("select all"); no anchor survives that. */
  function replace(ids: Iterable<number>) {
    selectedIds.value = new Set(ids)
    anchor.value = null
  }

  async function onToggleSelect(
    entry: GalleryGridEntry,
    context?: { index: number; range: boolean },
  ): Promise<void> {
    const from = anchor.value
    // A shift-click with no anchor yet (or from a position the grid could not
    // place) has no span to apply, so it falls through to a plain toggle.
    if (context?.range && from && context.index >= 0) {
      const { start, end } = rangeBounds(from.index, context.index)
      rangeBusy.value = true
      try {
        const ids = await collectRangeIds(start, end, source)
        selectedIds.value = applyRange(selectedIds.value, ids, from.adding)
      } catch {
        // Leave the selection as it was; the click can simply be repeated.
      } finally {
        rangeBusy.value = false
      }
      // The anchor stays put so further shift-clicks widen or narrow the same
      // span rather than walking it forward one click at a time.
      return
    }

    const { selected, adding } = toggleOne(selectedIds.value, entry.id)
    selectedIds.value = selected
    anchor.value = context && context.index >= 0 ? { index: context.index, adding } : null
  }

  return { selectedIds, selectedCount, anchor, rangeBusy, clear, replace, onToggleSelect }
}
