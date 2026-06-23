import type { Transaction } from '../api/finance'

export interface BasketAggregate { label: string; amount: number; count: number; aiOnly?: boolean }

function sort(items: BasketAggregate[]) {
  return items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || b.count - a.count || a.label.localeCompare(b.label, 'de'))
}

export function basketTags(items: Transaction[]): BasketAggregate[] {
  const result = new Map<string, BasketAggregate>()
  for (const tx of items) for (const tag of (tx.tags.length ? tx.tags : [{ name: 'Ohne Tag', source: 'user' as const }])) {
    const row = result.get(tag.name) ?? { label: tag.name, amount: 0, count: 0, aiOnly: tag.source === 'ai' }
    row.amount += Number(tx.amount) || 0; row.count++; if (tag.source !== 'ai') row.aiOnly = false; result.set(tag.name, row)
  }
  return sort([...result.values()])
}

function grouped(items: Transaction[], label: (tx: Transaction) => string) {
  const result = new Map<string, BasketAggregate>()
  for (const tx of items) { const key = label(tx); const row = result.get(key) ?? { label: key, amount: 0, count: 0 }; row.amount += Number(tx.amount) || 0; row.count++; result.set(key, row) }
  return sort([...result.values()])
}

export function basketCounterparties(items: Transaction[], limit = 5) {
  const all = grouped(items, tx => tx.counterparty?.trim() || 'Ohne Gegenseite')
  if (all.length <= limit) return all
  const rest = all.slice(limit).reduce((out, row) => ({ label: 'Sonstige', amount: out.amount + row.amount, count: out.count + row.count }), { label: 'Sonstige', amount: 0, count: 0 })
  return [...all.slice(0, limit), rest]
}

export function basketMonths(items: Transaction[]) { return grouped(items, tx => tx.booking_date.slice(0, 7) || 'Ohne Datum').sort((a, b) => a.label.localeCompare(b.label)) }
export function hasMixedCurrencies(items: Transaction[]) { return new Set(items.map(tx => tx.currency_code)).size > 1 }
