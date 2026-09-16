import { METER_TYPE_LABELS, type MeterType } from '../api/meters'

/**
 * Order the meter list reads in: all the electricity meters, then water, then
 * gas, then the hour counters, and inside each type by name.
 *
 * The type order is the one `METER_TYPE_LABELS` declares — the same order the
 * type dropdown offers — so the list and the form agree. Alphabetical labels
 * would put "Betriebsstunden" first, which is the least interesting group.
 */
const TYPE_ORDER = Object.keys(METER_TYPE_LABELS) as MeterType[]

function typeRank(type: MeterType): number {
  const index = TYPE_ORDER.indexOf(type)
  // A type the list does not know sorts last rather than first, so a future
  // meter type never jumps the queue before anyone has decided where it goes.
  return index < 0 ? TYPE_ORDER.length : index
}

/**
 * Names compared the way a German reader expects, with numbers read as
 * numbers: "Zähler 2" before "Zähler 10", and "Ölzähler" next to "Olzähler"
 * rather than after "Z".
 */
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

export function compareMetersByTypeAndName<T extends { type: MeterType; name: string }>(
  a: T,
  b: T,
): number {
  const byType = typeRank(a.type) - typeRank(b.type)
  if (byType !== 0) return byType
  return collator.compare(a.name, b.name)
}

/** A sorted copy — the caller's array stays as it came from the API. */
export function sortMetersByTypeAndName<T extends { type: MeterType; name: string }>(
  meters: readonly T[],
): T[] {
  return [...meters].sort(compareMetersByTypeAndName)
}
