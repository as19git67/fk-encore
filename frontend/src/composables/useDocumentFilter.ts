import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { replaceQuerySlice, updateRouteQuery } from '../utils/routeQueryUpdate'

const STORAGE_KEY = 'documents.filter'
export const DOCUMENT_FILTER_QUERY_KEYS = [
  'category', 'tags', 'status', 'review', 'neu', 'sender', 'correspondent', 'dateFrom', 'dateTo',
  'taxRelevant', 'subjectPerson', 'categorySource', 'documentType', 'collectionScope', 'collection',
] as const

export interface DocumentFilter {
  category?: string
  tags?: string[]
  status?: string
  needs_review?: boolean
  /** Only "new" documents: ready with unapproved AI attribution (#635). */
  unreviewed?: boolean
  sender?: string
  /** Canonical correspondent slug (facet filter). */
  correspondent?: string
  dateFrom?: string
  dateTo?: string
  taxRelevant?: boolean
  subjectPersonId?: number
  /** Filter by category source: 'ai', 'cloud', or 'user'. */
  categorySource?: string
  /** Filter by document-type facet slug (Dokumentart). */
  documentType?: string
  /**
   * How the list treats Sammelmappen membership. Absent means `'without'`,
   * the default: a document that is already bundled is represented by its
   * folder row instead of appearing a second time on its own. `'with'` is the
   * flat list of everything, `'only'` the inverse of the default.
   */
  collectionScope?: DocumentCollectionScope
  /** Keep only the members of this one Sammelmappe. Wins over `collectionScope`. */
  collectionId?: number
}

/**
 * What the list does with documents that sit in a Sammelmappe.
 *
 * - `without` (the default) — leave them out, because the folder row above the
 *   list already stands for them. Nothing is lost: the folder is one click
 *   away, the chip on a document names its folders, and the setting is undone
 *   in one click from the notice the list shows while it is in effect.
 * - `with` — the flat list of every document, folder or not.
 * - `only` — the complement of the default, for checking what is bundled.
 */
export type DocumentCollectionScope = 'without' | 'with' | 'only'

/** The scope in force, resolving the absent-means-default rule in one place. */
export function effectiveCollectionScope(f: DocumentFilter): DocumentCollectionScope {
  return f.collectionScope ?? 'without'
}

/**
 * The membership half of the backend query.
 *
 * A named folder supersedes the scope — asking for one folder's documents is
 * the more specific request — and `'with'` sends nothing at all, because "no
 * condition" is exactly what it means.
 */
export function collectionQueryParams(
  f: DocumentFilter,
): { in_collection?: boolean; collection_id?: number } {
  if (f.collectionId) return { collection_id: f.collectionId }
  const scope = effectiveCollectionScope(f)
  if (scope === 'without') return { in_collection: false }
  if (scope === 'only') return { in_collection: true }
  return {}
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
  const un = parseBool(q.neu)
  if (un === true) f.unreviewed = true
  if (typeof q.sender === 'string' && q.sender) f.sender = q.sender
  if (typeof q.correspondent === 'string' && q.correspondent) f.correspondent = q.correspondent
  if (typeof q.dateFrom === 'string' && q.dateFrom) f.dateFrom = q.dateFrom
  if (typeof q.dateTo === 'string' && q.dateTo) f.dateTo = q.dateTo
  const tr = parseBool(q.taxRelevant)
  if (tr !== undefined) f.taxRelevant = tr
  if (typeof q.subjectPerson === 'string' && q.subjectPerson) {
    const n = Number(q.subjectPerson)
    if (Number.isFinite(n)) f.subjectPersonId = n
  }
  if (typeof q.categorySource === 'string' && q.categorySource) f.categorySource = q.categorySource
  if (typeof q.documentType === 'string' && q.documentType) f.documentType = q.documentType
  // Only the two non-default scopes are ever written, so anything else —
  // absent, empty, a stale 'without', junk — resolves to the default.
  if (q.collectionScope === 'with' || q.collectionScope === 'only') {
    f.collectionScope = q.collectionScope
  }
  if (typeof q.collection === 'string' && q.collection) {
    const n = Number(q.collection)
    if (Number.isFinite(n)) f.collectionId = n
  }
  return f
}

export function docFilterToQuery(f: DocumentFilter): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.category) out.category = f.category
  if (f.tags && f.tags.length > 0) out.tags = f.tags.join(',')
  if (f.status) out.status = f.status
  if (f.needs_review) out.review = '1'
  if (f.unreviewed) out.neu = '1'
  if (f.sender) out.sender = f.sender
  if (f.correspondent) out.correspondent = f.correspondent
  if (f.dateFrom) out.dateFrom = f.dateFrom
  if (f.dateTo) out.dateTo = f.dateTo
  if (f.taxRelevant !== undefined) out.taxRelevant = String(f.taxRelevant)
  if (f.subjectPersonId) out.subjectPerson = String(f.subjectPersonId)
  if (f.categorySource) out.categorySource = f.categorySource
  if (f.documentType) out.documentType = f.documentType
  // The default stays out of the URL: a shared link should carry what the
  // sender changed, not a restatement of what the list does anyway.
  if (f.collectionScope && f.collectionScope !== 'without') {
    out.collectionScope = f.collectionScope
  }
  if (f.collectionId) out.collection = String(f.collectionId)
  return out
}

export function countActiveDocFilters(f: DocumentFilter): number {
  let n = 0
  if (f.category) n++
  if (f.tags && f.tags.length > 0) n++
  if (f.status) n++
  if (f.needs_review) n++
  if (f.unreviewed) n++
  if (f.sender) n++
  if (f.correspondent) n++
  if (f.dateFrom || f.dateTo) n++
  if (f.taxRelevant !== undefined) n++
  if (f.subjectPersonId) n++
  if (f.categorySource) n++
  if (f.documentType) n++
  // One facet, and only when it departs from the default: naming a folder
  // supersedes the scope, so counting both would show "2 Filter" for a single
  // decision, and counting the default would show one for an untouched list.
  if (f.collectionId || (f.collectionScope && f.collectionScope !== 'without')) n++
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

export interface UseDocumentFilterReturn {
  applied: Ref<DocumentFilter>
  draft: Ref<DocumentFilter>
  activeCount: Ref<number>
  openEdit: () => void
  apply: () => void
  reset: () => void
  removeKey: (keys: Array<keyof DocumentFilter>) => void
  /** Remove a single tag from the applied filter, persisting + syncing the URL. */
  removeTag: (tag: string) => void
}

export function useDocumentFilter(): UseDocumentFilterReturn {
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

  function syncUrl(f: DocumentFilter) {
    const filterQ = docFilterToQuery(f)
    return updateRouteQuery(router, (current) =>
      replaceQuerySlice(current, DOCUMENT_FILTER_QUERY_KEYS, filterQ),
    )
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

  function removeTag(tag: string) {
    const remaining = (applied.value.tags ?? []).filter((t) => t !== tag)
    const next = cloneFilter(applied.value)
    if (remaining.length > 0) next.tags = remaining
    else delete next.tags
    applied.value = next
    draft.value = cloneFilter(next)
    saveFilter(next)
    void syncUrl(next)
  }

  return { applied, draft, activeCount, openEdit, apply, reset, removeKey, removeTag }
}
