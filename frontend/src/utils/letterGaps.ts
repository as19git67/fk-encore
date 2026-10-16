/** A gap the assistant left in a letter for the user to fill in: `[[Zahlungsdatum]]` (#1534). */
const GAP_RE = /\[\[([^\]\n]{1,120})\]\]/g

/** The distinct gaps in the given texts, in order of appearance. */
export function letterGaps(...texts: string[]): string[] {
  const found = new Set<string>()
  for (const t of texts) {
    for (const m of t.matchAll(GAP_RE)) found.add((m[1] ?? '').trim())
  }
  return [...found]
}
