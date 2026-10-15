import type { ToolbarItem } from '../components/ResponsiveToolbar.vue'
import { ENTITY_LABELS, type CollectionEntityType, type MemberRef } from '../api/collections'

/**
 * The action menu of a mixed collection (#1548, stage 4).
 *
 * One menu, not one per type: the actions that work on anything (take out,
 * put into another collection, set aside) come first, then the actions of
 * each type present in the selection, each saying how many items it touches
 * — "Buchungen (3): Als geprüft markieren". With a single type selected the
 * prefix goes away and the menu reads like that module's own batch menu.
 */

const ORDER = Object.keys(ENTITY_LABELS) as CollectionEntityType[]

/**
 * A member as one number, because list selection keys rows by number. The
 * type takes the digits above 10^12, far beyond any row id here.
 */
const TYPE_FACTOR = 1_000_000_000_000

export function encodeMember(ref: MemberRef): number {
  return (ORDER.indexOf(ref.entity_type) + 1) * TYPE_FACTOR + ref.entity_id
}

export function decodeMember(key: number): MemberRef {
  const typeIndex = Math.floor(key / TYPE_FACTOR) - 1
  return { entity_type: ORDER[typeIndex]!, entity_id: key % TYPE_FACTOR }
}

/** Ids of the selection, by type. */
export function groupByType(refs: MemberRef[]): Map<CollectionEntityType, number[]> {
  const out = new Map<CollectionEntityType, number[]>()
  for (const r of refs) out.set(r.entity_type, [...(out.get(r.entity_type) ?? []), r.entity_id])
  return out
}

/** One type's batch action, given the ids of that type in the selection. */
export interface TypeAction {
  key: string
  title: string
  icon: string
  run: (ids: number[]) => void
}

export function groupedSelectionActions(
  selection: MemberRef[],
  generic: ToolbarItem[],
  catalog: Partial<Record<CollectionEntityType, TypeAction[]>>,
): ToolbarItem[] {
  if (selection.length === 0) return []
  const byType = groupByType(selection)
  const mixed = byType.size > 1
  const items: ToolbarItem[] = [...generic]
  for (const type of ORDER) {
    const ids = byType.get(type)
    const actions = catalog[type]
    if (!ids?.length || !actions?.length) continue
    const label = ENTITY_LABELS[type]
    for (const action of actions) {
      const title = mixed ? `${label.plural} (${ids.length}): ${action.title}` : action.title
      items.push({
        key: `${type}:${action.key}`,
        title,
        label: title,
        icon: action.icon,
        severity: 'secondary',
        command: () => action.run(ids),
      })
    }
  }
  return items
}
