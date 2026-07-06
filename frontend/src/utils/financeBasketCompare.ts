import type { Transaction } from '../api/finance'

export interface BasketComparisonRow { label: string; a: number; b: number; delta: number }

export function compareBasketCounterparties(a: Transaction[], b: Transaction[]): { currencyMismatch: boolean; rows: BasketComparisonRow[] } {
  const currencies = new Set([...a, ...b].map(item => item.currency_code))
  if (currencies.size > 1) return { currencyMismatch: true, rows: [] }
  const aggregate = (values: Transaction[]) => {
    const map = new Map<string, number>()
    for (const tx of values) {
      const key = tx.counterparty?.trim() || 'Ohne Gegenseite'
      map.set(key, (map.get(key) ?? 0) + Number(tx.amount))
    }
    return map
  }
  const am = aggregate(a); const bm = aggregate(b)
  return {
    currencyMismatch: false,
    rows: [...new Set([...am.keys(), ...bm.keys()])].sort().map(label => {
      const av = am.get(label) ?? 0; const bv = bm.get(label) ?? 0
      return { label, a: av, b: bv, delta: bv - av }
    }),
  }
}
