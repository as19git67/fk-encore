import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw } from 'vue-router'

const STORAGE_KEY = 'documents.filter'

export interface DocumentFilter {
  category?: string
  tags?: string[]
  status?: string
  needs_review?: boolean
  sender?: string
  dateFrom?: string
  dateTo?: string
  taxRelevant?: boolean
  subjectPersonId?: number
}

function parseBool(v: unknown): boolean | undefined {
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return undefined
}

function parseTags(v: unknown): string[] | undefined {
  if (typeof v === 'string' && v) return v.split(',').map((t) => t.trim()).filter(Boolean)
  return undefined
}

function cloneFilter(f: DocumentFilter): DocumentFilter {
  return { ...f, tags: f.tags ? [...f.tags] : undefined }
}

export function parseDocFilterFromQuery(q: Record<string, unknown>): DocumentFilter {
  const f: DocumentFilter = {}
  if (typeof q.category === 'string' && q.category) f.category = q.category
  const tags = parseTags(q.tags)
  if (tags && tags.length > 0) f.tags = tags
  if (typeof q.status === 'string' && q.status) f.status = q.status
  const nr = parseBool(q.review)
  if (nr === true) f.needs_review = true
  if (typeof q.sender === 'string' && q.sender) f.sender = q.sender
  if (typeof q.dateFrom === 'string' && q.dateFrom) f.dateFrom = q.dateFrom
  if (typeof q.dateTo === 'string' && q.dateTo) f.dateTo = q.dateTo
  const tr = parseBool(q.taxRelevant)
  if (tr !== undefined) f.taxRelevant = tr
  if (typeof q.subjectPerson === 'string' && q.subjectPerson) {
    const n = Number(q.subjectPerson)
    if (Number.isFinite(n)) f.subjectPersonId = n
  }
  return f
}

export function docFilterToQuery(f: DocumentFilter): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.category) out.category = f.category
  if (f.tags && f.tags.length > 0) out.tags = f.tags.join(',')
  if (f.status) out.status = f.status
  if (f.needs_review) out.review = '1'
  if (f.sender) out.sender = f.sender
  if (f.dateFrom) out.dateFrom = f.dateFrom
  if (f.dateTo) out.dateTo = f.dateTo
  if (f.taxRelevant !== undefined) out.taxRelevant = String(f.taxRelevant)
  if (f.subjectPersonId) out.subjectPerson = String(f.subjectPersonId)
  return out
}

export function countActiveDocFilters(f: DocumentFilter): number {
  let n = 0
  if (f.category) n++
  if (f.tags && f.tags.length > 0) n++
  if (f.status) n++
  if (f.needs_review) n++
  if (f.sender) n++
  if (f.dateFrom || f.dateTo) n++
  if (f.taxRelevant !== undefined) n++
  if (f.subjectPersonId) n++
  return n
}

function saveFilter(f: DocumentFilter) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(f)) } catch { /* ignore */ }
}

function loadFilter(): DocumentFilter | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as DocumentFilter
  } catch { return null }
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

  const fromQuery = parseDocFilterFromQuery(route.query as Record<string, unknown>)
  const hasQueryFilter = Object.keys(docFilterToQuery(fromQuery)).length > 0
  const initial = hasQueryFilter ? fromQuery : (loadFilter() ?? fromQuery)

  const applied = ref<DocumentFilter>(initial)
  const draft = ref<DocumentFilter>(cloneFilter(applied.value))
  const activeCount = computed(() => countActiveDocFilters(applied.value))

  if (!hasQueryFilter && countActiveDocFilters(initial) > 0) {
    void syncUrl(initial)
  }

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
    draft.value = cloneFilter(applied.value)
  }

  function apply() {
    applied.value = cloneFilter(draft.value)
    saveFilter(applied.value)
    void syncUrl(applied.value)
  }

  function reset() {
    draft.value = {}
    applied.value = {}
    saveFilter({})
    void syncUrl({})
  }

  function removeKey(keys: Array<keyof DocumentFilter>) {
    const next = cloneFilter(applied.value)
    for (const k of keys) delete (next as Record<string, unknown>)[k as string]
    applied.value = next
    draft.value = cloneFilter(next)
    saveFilter(next)
    void syncUrl(next)
  }

  return { applied, draft, activeCount, openEdit, apply, reset, removeKey }
}
