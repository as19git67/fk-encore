import { defineStore } from 'pinia'
import type { DocumentSummary } from '../../api/documents'
import { useSelection } from '../../composables/useSelection'
import { useBasketMirror } from '../../composables/useBasketMirror'
import { getDocument } from '../../api/documents'

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
  // The pile itself is the shared basket (#1548); this keeps the whole
  // documents the drawer computes with, cached per tab.
  const selection = useBasketMirror(
    useSelection<DocumentSummary>({
      storageKey: 'documents.docSelection.v1',
      isValidItem: (item) =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as DocumentSummary).id === 'number',
    }),
    {
      type: 'document',
      fetchOne: getDocument,
      display: (doc) => ({
        title: doc.title?.trim() || doc.original_filename,
        subtitle: doc.sender,
        date: doc.doc_date,
      }),
    },
  )

  /** Add many documents at once (e.g. a whole filter result), deduplicated. */
  const addAll = selection.addAll

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
