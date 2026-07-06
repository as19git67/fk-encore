import type { Transaction } from '../api/finance'

export interface RecurringSelectionGroup {
  counterparty: string
  count: number
  averageIntervalDays: number
  transactionIds: number[]
}

const DAY_MS = 86_400_000

export function detectRecurringSelection(items: Transaction[]): RecurringSelectionGroup[] {
  const byCounterparty = new Map<string, Transaction[]>()
  for (const item of items) {
    const name = item.counterparty?.trim()
    if (!name) continue
    const key = name.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const group = byCounterparty.get(key) ?? []
    group.push(item)
    byCounterparty.set(key, group)
  }

  const result: RecurringSelectionGroup[] = []
  for (const transactions of byCounterparty.values()) {
    const amountBuckets: Transaction[][] = []
    for (const transaction of transactions) {
      const amount = Number(transaction.amount)
      const bucket = amountBuckets.find(candidate => {
        const baseline = Number(candidate[0]!.amount)
        return Math.sign(amount) === Math.sign(baseline)
          && Math.abs(amount - baseline) <= Math.max(0.01, Math.abs(baseline) * 0.05)
      })
      if (bucket) bucket.push(transaction)
      else amountBuckets.push([transaction])
    }
    for (const bucket of amountBuckets) {
      if (bucket.length < 3) continue
      const sorted = [...bucket].sort((a, b) => a.booking_date.localeCompare(b.booking_date))
      const intervals = sorted.slice(1).map((item, index) =>
        Math.round((Date.parse(item.booking_date) - Date.parse(sorted[index]!.booking_date)) / DAY_MS),
      ).filter(days => days > 0)
      if (intervals.length < 2) continue
      const mean = intervals.reduce((sum, days) => sum + days, 0) / intervals.length
      const cadence = [7, 14, 30, 90, 365].some(expected => Math.abs(mean - expected) <= Math.max(3, expected * 0.15))
      const maxDeviation = Math.max(...intervals.map(days => Math.abs(days - mean)))
      if (!cadence || maxDeviation > Math.max(4, mean * 0.25)) continue
      result.push({
        counterparty: sorted[0]!.counterparty!,
        count: sorted.length,
        averageIntervalDays: Math.round(mean),
        transactionIds: sorted.map(item => item.id),
      })
    }
  }
  return result.sort((a, b) => b.count - a.count || a.counterparty.localeCompare(b.counterparty))
}
