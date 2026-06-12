/**
 * Typed client for the `documents` backend service.
 *
 * All endpoints are gated server-side by `module.documents` plus a
 * fine-grained permission (view/upload/edit/delete). The types here
 * mirror the DTOs in `documents/documents.ts`.
 */

import { API_BASE_URL, apiFetch } from './client'

export type DocumentStatus = 'pending' | 'extracting' | 'classifying' | 'ready' | 'failed'
export type SearchMode = 'fts' | 'semantic' | 'hybrid'
export type TaxSectionGroup = 'einkuenfte' | 'abzuege' | 'bescheid' | 'rahmen'
export type TaxAssignmentSource = 'ai' | 'user'
export type DocumentVisibility = 'private' | 'group'

export interface DocumentSummary {
  id: number
  title: string | null
  original_filename: string
  mime_type: string
  size_bytes: number
  status: DocumentStatus
  uploaded_at: string | null
  doc_date: string | null
  sender: string | null
  document_number: string | null
  category_id: number | null
  category_slug: string | null
  classification_confidence: number | null
  tags: string[]
  tax_relevant: boolean
  tax_year: number | null
  last_error: string | null
  visibility: DocumentVisibility
  group_id: number | null
}

export interface DocumentTaxSection {
  slug: string
  name: string
  group: TaxSectionGroup
  confidence: number | null
  source: TaxAssignmentSource
}

export interface DocumentDetail extends DocumentSummary {
  summary: string | null
  extracted_text_preview: string | null
  tax_reviewed: boolean
  tax_year_confidence: number | null
  tax_sections: DocumentTaxSection[]
}

export interface DocumentCategory {
  id: number
  slug: string
  name: string
  parent_id: number | null
  icon: string | null
  sort_order: number
}

export interface ListDocumentsResponse {
  items: DocumentSummary[]
  total: number
}

export interface SearchDocumentsResponse {
  items: DocumentSummary[]
  mode: SearchMode
  query: string
}

export interface ListDocumentsQuery {
  category?: string
  tags?: string
  q?: string
  status?: DocumentStatus
  /**
   * Filter to documents that need a human look: status='failed' OR
   * status='ready' with classification_confidence below 0.6.
   */
  needs_review?: boolean
  sender?: string
  date_from?: string
  date_to?: string
  tax_relevant?: boolean
  sort_by?: string
  sort_dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface UpdateDocumentPayload {
  title?: string | null
  doc_date?: string | null
  sender?: string | null
  document_number?: string | null
  summary?: string | null
  category_slug?: string | null
  tags?: string[]
}

export interface DocQueueServiceStatus {
  service: string
  pending: number
  processing: number
  failed: number
  done: number
}

export interface DocQueueStatus {
  services: DocQueueServiceStatus[]
}

function buildQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    qs.set(key, String(value))
  }
  const s = qs.toString()
  return s.length > 0 ? `?${s}` : ''
}

export function listDocuments(params: ListDocumentsQuery = {}) {
  return apiFetch<ListDocumentsResponse>(`/documents${buildQuery(params as Record<string, unknown>)}`)
}

export function getDocument(id: number) {
  return apiFetch<DocumentDetail>(`/documents/${id}`)
}

export function listDocumentCategories() {
  return apiFetch<{ items: DocumentCategory[] }>('/document-categories')
}

export function getDocumentQueueStatus() {
  return apiFetch<DocQueueStatus>('/document-queue/status')
}

export function cancelDocumentQueue() {
  return apiFetch<{ cancelled: number }>('/document-queue/cancel', { method: 'POST' })
}

export function retryDocumentQueue() {
  return apiFetch<{ retried: number }>('/document-queue/retry', { method: 'POST' })
}

export function searchDocuments(q: string, mode: SearchMode = 'hybrid', limit = 20) {
  return apiFetch<SearchDocumentsResponse>(
    `/documents/search${buildQuery({ q, mode, limit })}`,
  )
}

/**
 * Upload a PDF. Body is the raw file; the backend reads the filename
 * from the `X-File-Name` header and the MIME type from `Content-Type`.
 *
 * HTTP headers are restricted to ISO-8859-1, so the filename is
 * percent-encoded here and decoded server-side. This keeps umlauts and
 * other Unicode characters in filenames working.
 */
export function uploadDocument(file: File, signal?: AbortSignal) {
  return apiFetch<DocumentSummary>('/documents', {
    method: 'POST',
    body: file,
    signal,
    headers: {
      'Content-Type': file.type || 'application/pdf',
      'X-File-Name': encodeURIComponent(file.name),
    },
  })
}

export function updateDocument(id: number, payload: UpdateDocumentPayload) {
  return apiFetch<DocumentDetail>(`/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteDocument(id: number) {
  return apiFetch<{ success: boolean }>(`/documents/${id}`, { method: 'DELETE' })
}

export interface UpdateDocumentVisibilityPayload {
  visibility: DocumentVisibility
  group_id?: number | null
}

export function updateDocumentVisibility(id: number, payload: UpdateDocumentVisibilityPayload) {
  return apiFetch<DocumentDetail>(`/documents/${id}/visibility`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface BatchUpdateTagsPayload {
  document_ids: number[]
  add?: string[]
  remove?: string[]
}

export interface BatchUpdateTagsResponse {
  affected_documents: number
  added_links: number
  removed_links: number
}

export function batchUpdateDocumentTags(payload: BatchUpdateTagsPayload) {
  return apiFetch<BatchUpdateTagsResponse>(`/documents/batch/tags`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface BatchUpdateVisibilityPayload {
  document_ids: number[]
  visibility: DocumentVisibility
  group_id?: number | null
}

export interface BatchUpdateVisibilityResponse {
  affected_documents: number
  skipped_unauthorized: number
}

export function batchUpdateDocumentVisibility(payload: BatchUpdateVisibilityPayload) {
  return apiFetch<BatchUpdateVisibilityResponse>(`/documents/batch/visibility`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface BatchReclassifyPayload {
  document_ids: number[]
  force_ocr?: boolean
}

export interface BatchReclassifyResponse {
  affected_documents: number
}

export function batchReclassifyDocuments(payload: BatchReclassifyPayload) {
  return apiFetch<BatchReclassifyResponse>(`/documents/batch/reclassify`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface UploadDefaults {
  group_id: number | null
}

export function getUploadDefaults() {
  return apiFetch<UploadDefaults>(`/documents/upload-defaults`)
}

export function setUploadDefaults(payload: UploadDefaults) {
  return apiFetch<UploadDefaults>(`/documents/upload-defaults`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export type ReclassifyAllMode = 'classify_only' | 'full'

export function reclassifyAllDocuments(mode: ReclassifyAllMode) {
  return apiFetch<{ queued: number }>('/documents/reclassify-all', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })
}

export function reclassifyDocument(
  id: number,
  options: { forceOcr?: boolean } = {},
) {
  const body: Record<string, unknown> = { id }
  if (options.forceOcr !== undefined) body.force_ocr = options.forceOcr
  return apiFetch<{ success: boolean }>(`/documents/${id}/reclassify`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * Build the URL the `<iframe>` in the detail view points at.
 * Auth is cookie-less, so we append the token as a query parameter —
 * only the bearer-less raw endpoint needs this.
 */
export function getDocumentFileUrl(id: number): string {
  const token = localStorage.getItem('auth_token') ?? ''
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${API_BASE_URL}/documents/${id}/file${qs}`
}

/**
 * Fetch the PDF as raw bytes for the in-app pdfjs viewer.
 * pdfjs takes ownership of the buffer, so we always return a fresh copy.
 */
export async function fetchDocumentBytes(id: number): Promise<Uint8Array> {
  const token = localStorage.getItem('auth_token')
  const res = await fetch(`${API_BASE_URL}/documents/${id}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`PDF ${id}: HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

// ─── Tax-return helpers ───────────────────────────────────────────────────

export interface TaxSectionCatalogEntry {
  slug: string
  name: string
  group: TaxSectionGroup
  hint: string
}

export function listTaxSectionsCatalog() {
  return apiFetch<{ items: TaxSectionCatalogEntry[] }>('/documents/tax/sections')
}

export interface TaxYearCount {
  year: number
  count: number
}

export interface TaxYearsResponse {
  years: TaxYearCount[]
}

export interface TaxDocumentAssignment {
  document: DocumentSummary
  confidence: number | null
  source: TaxAssignmentSource
}

export interface TaxSectionBucket {
  slug: string
  name: string
  group: TaxSectionGroup
  documents: TaxDocumentAssignment[]
}

export interface ListTaxDocumentsResponse {
  year: number | null
  total_documents: number
  sections: TaxSectionBucket[]
}

export interface UpdateDocumentTaxPayload {
  tax_relevant: boolean
  tax_year?: number | null
  tax_sections?: string[]
}

export function listTaxYears() {
  return apiFetch<TaxYearsResponse>('/documents/tax/years')
}

export function listTaxDocuments(params: { year?: number; section?: string } = {}) {
  return apiFetch<ListTaxDocumentsResponse>(`/documents/tax${buildQuery(params as Record<string, unknown>)}`)
}

export function updateDocumentTax(id: number, payload: UpdateDocumentTaxPayload) {
  return apiFetch<DocumentDetail>(`/documents/${id}/tax`, {
    method: 'POST',
    body: JSON.stringify({ id, ...payload }),
  })
}

export function backfillDocumentTax() {
  return apiFetch<{ queued: number }>('/documents/tax/backfill', { method: 'POST' })
}

// ─── Tax hint admin ───────────────────────────────────────────────────────

export interface TaxHintEntry {
  slug: string
  name: string
  group: TaxSectionGroup
  default_hint: string
  effective_hint: string
  is_overridden: boolean
  updated_at: string | null
}

export function listTaxHints() {
  return apiFetch<{ items: TaxHintEntry[] }>('/documents/tax/hints')
}

export function updateTaxHint(slug: string, hint: string) {
  return apiFetch<TaxHintEntry>(`/documents/tax/hints/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    body: JSON.stringify({ slug, hint }),
  })
}

export function resetTaxHint(slug: string) {
  return apiFetch<TaxHintEntry>(`/documents/tax/hints/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
}

export function reclassifyTaxSection(slug: string, includeReviewed = false) {
  return apiFetch<{ queued: number }>(
    `/documents/tax/hints/${encodeURIComponent(slug)}/reclassify`,
    {
      method: 'POST',
      body: JSON.stringify({ slug, include_reviewed: includeReviewed }),
    },
  )
}

// ─── Subject persons (Bezugspersonen) ────────────────────────────────────

export interface SubjectPerson {
  id: number
  full_name: string
  relation_tag: string
  created_at: string
  updated_at: string
}

export function listSubjectPersons() {
  return apiFetch<{ items: SubjectPerson[] }>('/documents/subject-persons')
}

export function createSubjectPerson(input: { full_name: string; relation_tag: string }) {
  return apiFetch<SubjectPerson>('/documents/subject-persons', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateSubjectPerson(
  id: number,
  patch: { full_name?: string; relation_tag?: string },
) {
  return apiFetch<SubjectPerson>(`/documents/subject-persons/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ id, ...patch }),
  })
}

export function deleteSubjectPerson(id: number) {
  return apiFetch<{ success: boolean }>(`/documents/subject-persons/${id}`, {
    method: 'DELETE',
  })
}

// ─── Groups ──────────────────────────────────────────────────────────────

export interface GroupSummary {
  id: number
  slug: string
  name: string
  my_role: 'owner' | 'member'
  member_count: number
}

export function listGroups() {
  return apiFetch<{ items: GroupSummary[] }>('/groups')
}

export function getGroup(id: number) {
  return apiFetch<GroupSummary & { members: GroupMemberDTO[] }>(`/groups/${id}`)
}

export function createGroup(name: string) {
  return apiFetch<GroupSummary>('/groups', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function updateGroup(id: number, name: string) {
  return apiFetch<GroupSummary>(`/groups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export function deleteGroup(id: number) {
  return apiFetch<{ success: boolean }>(`/groups/${id}`, { method: 'DELETE' })
}

export function addGroupMember(id: number, email: string, role: 'owner' | 'member') {
  return apiFetch<{ success: boolean }>(`/groups/${id}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_email: email, role }),
  })
}

export function removeGroupMember(id: number, userId: number) {
  return apiFetch<{ success: boolean }>(`/groups/${id}/members/${userId}`, {
    method: 'DELETE',
  })
}

export interface GroupMemberDTO {
  user_id: number
  email: string
  name: string | null
  role: 'owner' | 'member'
  joined_at: string | null
}

// ─── Category suggestions (admin) ────────────────────────────────────────

export type CategorySuggestionStatus = 'open' | 'accepted' | 'rejected'

export interface CategorySuggestion {
  id: number
  suggested_name: string
  parent_slug: string | null
  example_document_ids: number[]
  rationale: string | null
  status: CategorySuggestionStatus
  created_at: string | null
}

export function listCategorySuggestions(status: CategorySuggestionStatus = 'open') {
  return apiFetch<{ items: CategorySuggestion[] }>(
    `/document-category-suggestions${buildQuery({ status })}`,
  )
}

export interface AcceptCategorySuggestionPayload {
  slug?: string
  name?: string
}

export function acceptCategorySuggestion(id: number, payload: AcceptCategorySuggestionPayload = {}) {
  return apiFetch<{ category_id: number; slug: string }>(
    `/document-category-suggestions/${id}/accept`,
    {
      method: 'POST',
      body: JSON.stringify({ id, ...payload }),
    },
  )
}

export function rejectCategorySuggestion(id: number) {
  return apiFetch<{ success: boolean }>(`/document-category-suggestions/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}
