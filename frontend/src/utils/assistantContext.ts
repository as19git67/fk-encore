/**
 * Handing objects to the assistant (#1534): a selection, or the document a
 * reply is for, opens `/assistent?context=document:12,document:13` and the
 * assistant page starts a conversation with that working set.
 */
import type { RouteLocationRaw } from 'vue-router'
import type { ContextRef } from '../api/assistant'

/** As many objects as the server keeps in one working set. */
export const MAX_ASSISTANT_CONTEXT = 25

const TYPES = new Set<ContextRef['type']>(['document', 'photo', 'transaction'])

export function contextQuery(refs: ContextRef[]): string {
  return refs.slice(0, MAX_ASSISTANT_CONTEXT).map((r) => `${r.type}:${r.id}`).join(',')
}

export function parseContextQuery(raw: unknown): ContextRef[] {
  if (typeof raw !== 'string' || !raw) return []
  const out: ContextRef[] = []
  for (const part of raw.split(',')) {
    const [type, id] = part.split(':')
    const n = Number(id)
    if (TYPES.has(type as ContextRef['type']) && Number.isInteger(n) && n > 0) {
      out.push({ type: type as ContextRef['type'], id: n })
    }
  }
  return out.slice(0, MAX_ASSISTANT_CONTEXT)
}

/** Where to go to ask the assistant about `refs`, with a question to start from. */
export function assistantLocation(refs: ContextRef[], prompt?: string): RouteLocationRaw {
  const query: Record<string, string> = { context: contextQuery(refs) }
  if (prompt) query.prompt = prompt
  return { path: '/assistent', query }
}
