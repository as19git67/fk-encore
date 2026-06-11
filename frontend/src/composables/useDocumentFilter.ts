import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw } from 'vue-router'

export interface DocumentFilter {
  category?: string
  tag?: string
  status?: string
  needs_review?: boolean
  sender?: string
  dateFrom?: string
  dateTo?: string
  taxRelevant?: boolean
}

function parseBool(v: unknown): boolean | undefined {
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return undefined
}

export function parseDocFilterFromQuery(q: Record<string, unknown>): DocumentFilter {
  const f: DocumentFilter = {}
  if (typeof q.category === 'string' && q.category) f.category = q.category
  if (typeof q.tag === 'string' && q.tag) f.tag = q.tag
  if (typeof q.status === 'string' && q.status) f.status = q.status
  const nr = parseBool(q.review)
  if (nr === true) f.needs_review = true
  if (typeof q.sender === 'string' && q.sender) f.sender = q.sender
  if (typeof q.dateFrom === 'string' && q.dateFrom) f.dateFrom = q.dateFrom
  if (typeof q.dateTo === 'string' && q.dateTo) f.dateTo = q.dateTo
  const tr = parseBool(q.taxRelevant)
  if (tr !== undefined) f.taxRelevant = tr
  return f
}

export function docFilterToQuery(f: DocumentFilter): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.category) out.category = f.category
  if (f.tag) out.tag = f.tag
  if (f.status) out.status = f.status
  if (f.needs_review) out.review = '1'
  if (f.sender) out.sender = f.sender
  if (f.dateFrom) out.dateFrom = f.dateFrom
  if (f.dateTo) out.dateTo = f.dateTo
  if (f.taxRelevant !== undefined) out.taxRelevant = String(f.taxRelevant)
  return out
}

export function countActiveDocFilters(f: DocumentFilter): number {
  let n = 0
  if (f.category) n++
  if (f.tag) n++
  if (f.status) n++
  if (f.needs_review) n++
  if (f.sender) n++
  if (f.dateFrom || f.dateTo) n++
  if (f.taxRelevant !== undefined) n++
  return n
}

export interface UseDocumentFilterOptions {
  preserveKeys?: string[]
}

export interface UseDocumentFilterReturn {
  applied: Ref<DocumentFilter>
  draft: Ref<DocumentFilter>
  activeCount: Ref<number>
  openEdit: () => void
  apply: () => void
  reset: () => void
  removeKey: (keys: Array<keyof DocumentFilter>) => void
}

export function useDocumentFilter(opts: UseDocumentFilterOptions = {}): UseDocumentFilterReturn {
  const route = useRoute()
  const router = useRouter()

  const applied = ref<DocumentFilter>(parseDocFilterFromQuery(route.query as Record<string, unknown>))
  const draft = ref<DocumentFilter>({ ...applied.value })
  const activeCount = computed(() => countActiveDocFilters(applied.value))

  watch(
    () => route.query,
    (q) => {
      const next = parseDocFilterFromQuery(q as Record<string, unknown>)
      const nextUrl = JSON.stringify(docFilterToQuery(next))
      const appliedUrl = JSON.stringify(docFilterToQuery(applied.value))
      if (nextUrl !== appliedUrl) {
        applied.value = next
      }
    },
  )

  async function syncUrl(f: DocumentFilter) {
    const filterQ = docFilterToQuery(f)
    const preserved: Record<string, unknown> = {}
    for (const key of opts.preserveKeys ?? []) {
      const v = route.query[key]
      if (v !== undefined) preserved[key] = v
    }
    const nextQuery = { ...preserved, ...filterQ } as LocationQueryRaw
    if (JSON.stringify(nextQuery) === JSON.stringify(route.query)) return
    await router.replace({ query: nextQuery })
  }

  function openEdit() {
    draft.value = { ...applied.value }
  }

  function apply() {
    applied.value = { ...draft.value }
    void syncUrl(applied.value)
  }

  function reset() {
    draft.value = {}
    applied.value = {}
    void syncUrl({})
  }

  function removeKey(keys: Array<keyof DocumentFilter>) {
    const next = { ...applied.value }
    for (const k of keys) delete (next as Record<string, unknown>)[k as string]
    applied.value = next
    draft.value = { ...next }
    void syncUrl(next)
  }

  return { applied, draft, activeCount, openEdit, apply, reset, removeKey }
}
