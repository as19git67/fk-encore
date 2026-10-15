import type { RouteLocationRaw } from 'vue-router'
import type { CollectionEntityType, CollectionKind } from '../api/collections'

/**
 * Where a collection opens (#1548, stage 3).
 *
 * A collection typed for one kind opens that module's own list, limited to
 * its members: the same columns, sort, filters and batch actions as always.
 * Document folders keep their folder page (order, pages, PDF). Everything
 * else — mixed collections, securities, single meter readings — opens the
 * generic collection page.
 */
export function collectionRoute(c: {
  id: number
  entity_type: CollectionEntityType | null
  kind?: CollectionKind
}): RouteLocationRaw {
  if (c.kind === 'dossier') return { name: 'dokumente-mappe', params: { id: c.id } }
  switch (c.entity_type) {
    case 'document':
      return { name: 'dokumente-mappe', params: { id: c.id } }
    case 'photo':
      return { name: 'fotos-gallery', query: { collection: String(c.id) } }
    case 'album':
      return { name: 'fotos-albums', query: { collection: String(c.id) } }
    case 'transaction':
      return { name: 'finance-collection-transactions', params: { collectionId: c.id } }
    case 'meter':
      return { name: 'zaehler-list', query: { collection: String(c.id) } }
    default:
      return { name: 'sammelmappe-detail', params: { id: c.id } }
  }
}

/** The module list a type's members open in, limited to one collection; null without one. */
export function typeListRoute(type: CollectionEntityType, collectionId: number): RouteLocationRaw | null {
  switch (type) {
    case 'document':
      return { name: 'dokumente-list', query: { collection: String(collectionId) } }
    case 'photo':
      return { name: 'fotos-gallery', query: { collection: String(collectionId) } }
    case 'album':
      return { name: 'fotos-albums', query: { collection: String(collectionId) } }
    case 'transaction':
      return { name: 'finance-collection-transactions', params: { collectionId } }
    case 'meter':
      return { name: 'zaehler-list', query: { collection: String(collectionId) } }
    default:
      return null
  }
}

/** Where one member opens, when its type has a page of its own. */
export function memberRoute(type: CollectionEntityType, id: number): RouteLocationRaw | null {
  switch (type) {
    case 'document':
      return { name: 'dokumente-detail', params: { id } }
    case 'transaction':
      return { name: 'finance-transaction-detail', params: { id } }
    case 'photo':
      return { name: 'fotos-gallery', query: { photoId: String(id) } }
    case 'album':
      return { name: 'fotos-album-detail', params: { id } }
    case 'meter':
      return { name: 'zaehler-detail', params: { id } }
    default:
      return null
  }
}
