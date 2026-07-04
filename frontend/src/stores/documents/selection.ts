import { defineStore } from 'pinia'
import type { DocumentSummary } from '../../api/documents'
import { useSelection } from '../../composables/useSelection'

/**
 * Documents-specific selection: the user's document basket (issue #736),
 * mirroring the finance transaction basket. Documents are collected from
 * the list view (single picks or a whole filter result) and acted on from
 * the basket drawer (batch tags / category / date / tax / Bezugspersonen)
 * or used as a navigation list in the detail view.
 *
 * Set operations + sessionStorage persistence live in the generic
 * useSelection<T> composable.
 */

export const useDocSelectionStore = defineStore('documents.docSelection', () => {
  const selection = useSelection<DocumentSummary>({
    storageKey: 'documents.docSelection.v1',
    isValidItem: (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as DocumentSummary).id === 'number',
  })

  /** Add many documents at once (e.g. a whole filter result), deduplicated. */
  function addAll(docs: DocumentSummary[]) {
    const known = new Set(selection.items.value.map((d) => d.id))
    const fresh = docs.filter((d) => !known.has(d.id))
    if (fresh.length > 0) selection.set([...selection.items.value, ...fresh])
  }

  /** Basket position of a document id, -1 when absent. Drives detail-view nav. */
  function indexOf(id: number): number {
    return selection.items.value.findIndex((d) => d.id === id)
  }

  return {
    items: selection.items,
    ids: selection.ids,
    count: selection.count,
    add: selection.add,
    addAll,
    remove: selection.remove,
    toggle: selection.toggle,
    set: selection.set,
    clear: selection.clear,
    has: selection.has,
    indexOf,
  }
})
