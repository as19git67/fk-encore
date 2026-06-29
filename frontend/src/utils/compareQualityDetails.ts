export interface QualityComparisonRow {
  key: string
  first: number | null
  second: number | null
}
function normalizedScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

/** Build stable rows from every criterion returned for either photo. */
export function qualityComparisonRows(
  first: Record<string, number> | null | undefined,
  second: Record<string, number> | null | undefined,
): QualityComparisonRow[] {
  const keys = new Set([...Object.keys(first ?? {}), ...Object.keys(second ?? {})])
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      first: normalizedScore(first?.[key]),
      second: normalizedScore(second?.[key]),
    }))
}
