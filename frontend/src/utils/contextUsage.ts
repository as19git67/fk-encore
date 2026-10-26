/**
 * The line under the assistant's chat that says how full the model's window
 * got in the latest answer, and how much of the conversation it still saw.
 */
import type { ContextUsage } from '../api/assistant'

/** From here on the meter warns: the next longer turn will push something out. */
const WARN_SHARE = 0.8

export interface ContextMeter {
  /** 0…1 of the window (or of the loop's budget, when the model gave no count). */
  share: number
  percent: number
  /** True when the share is the loop's estimate, not the model's count. */
  estimated: boolean
  warn: boolean
  /** Short pieces, joined with " · " on screen. */
  parts: string[]
  /** One sentence for screen readers and the tooltip. */
  description: string
}

function tokens(n: number): string {
  return n.toLocaleString('de-DE')
}

export function contextMeter(u: ContextUsage): ContextMeter {
  const counted = u.used !== null && u.window !== null && u.window > 0
  const share = counted ? u.used! / u.window! : u.budget > 0 ? u.estimated / u.budget : 0
  const percent = Math.round(Math.min(share, 1) * 100)
  const earlier = u.earlierTurns ?? u.historyTurns
  // Fewer earlier questions than asked: dropped for room, or never replayed.
  const shortened = u.keptTurns < earlier || u.digested > 0
  const parts = [
    counted
      ? `${tokens(u.used!)} von ${tokens(u.window!)} Tokens`
      : `ca. ${tokens(u.estimated)} von ${tokens(u.budget)} Tokens (geschätzt)`,
  ]
  if (earlier > 0) parts.push(`${u.keptTurns} von ${earlier} früheren Fragen im Blick`)
  if (u.digested > 0) parts.push(`${u.digested} Ergebnis${u.digested === 1 ? '' : 'se'} gekürzt`)
  const summarized = u.summarizedTurns ?? 0
  if (summarized > 0) parts.push(`${summarized} ältere als Zusammenfassung`)

  const sentences = [
    `Die letzte Antwort hat ${percent} % des Kontexts belegt (${parts[0]}).`,
  ]
  if (earlier > 0) {
    sentences.push(`Das Modell sah ${u.keptTurns} von ${earlier} früheren Fragen.`)
  }
  if (u.digested > 0) {
    sentences.push(`${u.digested} ältere Ergebnis${u.digested === 1 ? '' : 'se'} nur als Kurzfassung, um Platz zu schaffen.`)
  }
  if (summarized > 0) {
    sentences.push(`${summarized} ältere Frage${summarized === 1 ? '' : 'n'} nur als Zusammenfassung ihrer Antwort.`)
  }
  return {
    share,
    percent,
    estimated: !counted,
    warn: share >= WARN_SHARE || shortened,
    parts,
    description: sentences.join(' '),
  }
}

/** The usage of the newest answer that has one. */
export function latestUsage(messages: Array<{ role: string; context_usage?: ContextUsage | null }>): ContextUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]!.context_usage
    if (messages[i]!.role === 'assistant' && u) return u
  }
  return null
}
