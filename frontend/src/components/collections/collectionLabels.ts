import { ENTITY_LABELS, type CollectionSummary } from '../../api/collections'

/**
 * How a collection names its kind on a tile, in a table and in a menu: one
 * wording wherever a Sammelmappe is listed — the Sammelmappen page, the
 * document list and Dokumente › Sammelmappen.
 */
export function collectionTypeLabel(c: Pick<CollectionSummary, 'kind' | 'entity_type'>): string {
  if (c.kind === 'dossier') return 'Akte'
  if (c.kind === 'rule' && c.entity_type) return `${ENTITY_LABELS[c.entity_type].plural} · Regel`
  return c.entity_type ? ENTITY_LABELS[c.entity_type].plural : 'Gemischt'
}

export function collectionTypeIcon(c: Pick<CollectionSummary, 'entity_type'>): string {
  return c.entity_type ? ENTITY_LABELS[c.entity_type].icon : 'pi pi-folder'
}
