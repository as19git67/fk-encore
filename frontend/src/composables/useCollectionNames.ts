import { reactive } from 'vue'
import { getAnyCollection } from '../api/collections'

/**
 * Names of collections by id, for the "Sammelmappe: …" chip a list shows
 * while it is scoped to one (#1548, stage 3).
 *
 * Shared across views and asked once per id; until the answer arrives (or
 * when the caller may not read the collection) the chip says "#id".
 */

const names = reactive(new Map<number, string>())
const pending = new Set<number>()

export function collectionName(id: number): string {
  const known = names.get(id)
  if (known !== undefined) return known
  if (!pending.has(id)) {
    pending.add(id)
    getAnyCollection(id)
      .then((c) => names.set(id, c.name))
      .catch(() => names.set(id, `#${id}`))
  }
  return `#${id}`
}

/** Tell the cache a name it learned elsewhere (the collections page). */
export function rememberCollectionName(id: number, name: string): void {
  names.set(id, name)
}
