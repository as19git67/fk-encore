/**
 * Typed client for the `documents` backend service.
 *
 * All endpoints are gated server-side by `module.documents` plus a
 * fine-grained permission (view/upload/edit/delete). The types here
 * mirror the DTOs in `documents/documents.ts`.
 */

import { API_BASE_URL, apiFetch } from './client'

export type DocumentStatus = 'pending' | 'extracting' | 'classifying' | 'ready' | 'failed' | 'encrypted'
export type SearchMode = 'fts' | 'semantic' | 'hybrid'
export type TaxSectionGroup = 'einkuenfte' | 'abzuege' | 'bescheid' | 'rahmen'
export type TaxAssignmentSource = 'ai' | 'user'
export type CategorySource = 'ai' | 'cloud' | 'user'
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
  correspondent_slug: string | null
  correspondent_display: string | null
  category_id: number | null
  category_slug: string | null
  classification_confidence: number | null
  /** Document-type facet slug (Dokumentart), or null when untyped. */
  document_type: string | null
  tags: string[]
  tax_relevant: boolean
  tax_year: number | null
  last_error: string | null
  visibility: DocumentVisibility
  group_id: number | null
  /** Free-form human notes (shared document metadata). */
  notes: string | null
  /**
   * True when a human pinned the editable attributes. `false` on a ready
   * document marks it as "new": AI-only attribution awaiting approval (#635).
   */
  attributes_reviewed: boolean
  category_source: CategorySource
}

export interface DocumentTaxSection {
  slug: string
  name: string
  group: TaxSectionGroup
  confidence: number | null
  source: TaxAssignmentSource
}

export interface DocumentSubjectPerson {
  id: number
  full_name: string
  relation_tag: string
  source: TaxAssignmentSource
}

export type RetentionClass = 'dauerhaft' | 'steuer_10' | 'bis_ende' | 'kurz' | 'unbekannt'

export interface DocumentRetention {
  cls: RetentionClass
  /** Short German label, e.g. "Ca. 10 Jahre (steuerlich)". */
  label: string
  /** One-line German rationale. */
  note: string
  /** Earliest year the document may be discarded, or null when not year-based. */
  retain_until_year: number | null
}

/** One field the vision model read off page 1's letterhead. */
export interface DocumentLetterheadReading {
  /** As the model read it — the document's own spelling and date format. */
  value: string
  /** Whether the reading was found in the page's own OCR words. */
  located: boolean
  /** The 1-based page it was read from, when recorded. */
  page: number | null
}

export interface DocumentLetterhead {
  date: DocumentLetterheadReading | null
  /** The caption the date was taken from, or null when it stood unlabelled. */
  date_label: string | null
  sender: DocumentLetterheadReading | null
  /** ISO 639-1, as the model judged the page's prose. */
  language: string | null
}

export interface DocumentDetail extends DocumentSummary {
  summary: string | null
  extracted_text_preview: string | null
  /**
   * What the vision model read off the letterhead, or null when that stage
   * never ran for this document. The distinction matters when a date is
   * missing: "found nothing" and "was never asked" look identical otherwise.
   */
  letterhead: DocumentLetterhead | null
  tax_reviewed: boolean
  tax_year_confidence: number | null
  tax_sections: DocumentTaxSection[]
  /** Derived retention guidance (Aufbewahrungsfrist) — orientation, not advice. */
  retention: DocumentRetention
  /** Bezugspersonen this document concerns. */
  subject_persons: DocumentSubjectPerson[]
  /** True when flagged for the next Cloud-Teacher run (see migration 0133). */
  teacher_requested: boolean
  /**
   * True when the classifier put a personal-deduction tax section on a document
   * concerning a Bezugsperson (migration 0136). A soft "did you actually pay
   * this deductible expense?" prompt — the category itself is not in doubt.
   */
  tax_review_needed: boolean
}

export interface DocumentReceiptSuggestion {
  document: DocumentSummary
  status: DocumentStatus
  last_error: string | null
  amount: number | null
  doc_date: string | null
  sender: string | null
  note: string | null
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
  items: SearchDocumentSummary[]
  mode: SearchMode
  query: string
}

export interface SearchDocumentSummary extends DocumentSummary {
  extracted_text_preview: string | null
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
  /** Keep only "new" documents: ready with unapproved AI attribution (#635). */
  unreviewed?: boolean
  sender?: string
  /** Keep only documents whose persisted correspondent matches this slug. */
  correspondent?: string
  date_from?: string
  date_to?: string
  tax_relevant?: boolean
  /** Keep only documents linked to this Bezugsperson. */
  subject_person_id?: number
  /** Filter by category source: 'ai', 'cloud', or 'user'. */
  category_source?: CategorySource
  /** Filter by document-type facet slug (Dokumentart). */
  document_type?: string
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
  /** Override the document-type facet (Dokumentart); null clears it. */
  document_type?: string | null
  tags?: string[]
  /**
   * Explicitly set/clear the "human-pinned attributes" flag. Editing any
   * attribute already pins implicitly; send `false` to hand the document back
   * to the classifier ("let the AI decide again").
   */
  attributes_reviewed?: boolean
  /** Replace the user-curated Bezugsperson links (subject-person ids). */
  subject_person_ids?: number[]
  /** Free-form notes; independent metadata (never pins attributes). */
  notes?: string | null
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

// ─── Correspondents: facet + overrides ──────────────────────────────────────

export interface CorrespondentFacet {
  slug: string
  display: string
  count: number
}

/** Distinct correspondents across the caller's documents, most frequent first. */
export function listCorrespondents() {
  return apiFetch<{ items: CorrespondentFacet[] }>('/documents/correspondents')
}

export interface CorrespondentOverride {
  id: number
  sender_pattern: string
  correspondent_slug: string
  correspondent_display: string
}

export function listCorrespondentOverrides() {
  return apiFetch<{ items: CorrespondentOverride[] }>('/documents/correspondent-overrides')
}

export function createCorrespondentOverride(payload: {
  sender_pattern: string
  correspondent_display: string
  correspondent_slug?: string
}) {
  return apiFetch<CorrespondentOverride>('/documents/correspondent-overrides', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function deleteCorrespondentOverride(id: number) {
  return apiFetch<{ deleted: boolean }>(`/documents/correspondent-overrides/${id}`, {
    method: 'DELETE',
  })
}

export function getDocument(id: number) {
  return apiFetch<DocumentDetail>(`/documents/${id}`)
}

/** Full extracted text (the detail payload only carries a truncated preview). */
export function getDocumentText(id: number) {
  return apiFetch<{ text: string | null }>(`/documents/${id}/text`)
}

export function listDocumentCategories() {
  return apiFetch<{ items: DocumentCategory[] }>('/document-categories')
}

export interface DocumentTypeCatalogEntry {
  slug: string
  name: string
}

/** The controlled document-type vocabulary (Dokumentart), for filter + labels. */
export function listDocumentTypesCatalog() {
  return apiFetch<{ items: DocumentTypeCatalogEntry[] }>('/document-types')
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

/**
 * Filter-panel parameters shared by `listDocuments` and `searchDocuments`,
 * so an active filter narrows the result set whether or not a search term is
 * present.
 */
export type DocumentFilterParams = Pick<
  ListDocumentsQuery,
  | 'category'
  | 'tags'
  | 'status'
  | 'needs_review'
  | 'unreviewed'
  | 'sender'
  | 'date_from'
  | 'date_to'
  | 'tax_relevant'
  | 'subject_person_id'
  | 'category_source'
  | 'document_type'
>

export function searchDocuments(
  q: string,
  mode: SearchMode = 'hybrid',
  limit = 20,
  filters: DocumentFilterParams = {},
  sort?: { sort_by: string; sort_dir: 'asc' | 'desc' },
) {
  return apiFetch<SearchDocumentsResponse>(
    `/documents/search${buildQuery({ q, mode, limit, ...filters, ...sort })}`,
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

export function uploadReceiptCapture(
  file: File,
  accountId?: number,
  signal?: AbortSignal,
  transactionId?: number,
) {
  return apiFetch<DocumentSummary>('/documents/receipt-capture', {
    method: 'POST',
    body: file,
    signal,
    headers: {
      'Content-Type': receiptContentType(file),
      'X-File-Name': encodeURIComponent(file.name || 'receipt.jpg'),
      ...(accountId != null ? { 'X-Account-Id': String(accountId) } : {}),
      ...(transactionId != null ? { 'X-Transaction-Id': String(transactionId) } : {}),
    },
  })
}

export interface ReceiptOcrResult {
  amount: number | null
  date: string | null
  store: string | null
  currency: string
  items: { name: string; amount: number }[]
  raw_text: string
  ocr_confidence: number
  amount_confidence: number
  amount_source: string | null
  layout_rows: Array<{
    text: string
    cells: Array<{ text: string; x: number; width: number; confidence: number }>
  }>
  processing_ms: number
}

export function extractReceiptOcr(file: File, signal?: AbortSignal) {
  return apiFetch<ReceiptOcrResult>('/documents/receipt-ocr', {
    method: 'POST',
    body: file,
    signal,
    // Must exceed the backend's receipt-ocr client timeout (120s) so a slow
    // CPU extraction surfaces as a meaningful 502 from the server rather than
    // the browser aborting first — while still guaranteeing the UI can never
    // get stuck on "Beleg wird erkannt …" indefinitely.
    timeoutMs: 130_000,
    headers: {
      'Content-Type': receiptContentType(file),
      'X-File-Name': encodeURIComponent(file.name || 'receipt.jpg'),
    },
  })
}

export interface ReceiptOcrItemsResult {
  items: { name: string; amount: number }[]
}

// Second-stage line-item extraction from the raw_text returned by
// extractReceiptOcr. Best-effort and asynchronous — never blocks saving.
export function extractReceiptItems(text: string, signal?: AbortSignal) {
  return apiFetch<ReceiptOcrItemsResult>('/documents/receipt-ocr-items', {
    method: 'POST',
    body: JSON.stringify({ text }),
    signal,
    timeoutMs: 130_000,
  })
}

export function getDocumentReceiptSuggestion(id: number) {
  return apiFetch<DocumentReceiptSuggestion>(`/documents/${id}/receipt-suggestion`)
}

function receiptContentType(file: File): string {
  if (file.type) return file.type
  const name = file.name.toLowerCase()
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.heic')) return 'image/heic'
  if (name.endsWith('.heif')) return 'image/heif'
  if (name.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
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

/** Flag (or un-flag) a document for the next Cloud-Teacher run. */
export function setTeacherRequested(id: number, requested: boolean) {
  return apiFetch<DocumentDetail>(`/documents/${id}/teacher-request`, {
    method: 'POST',
    body: JSON.stringify({ requested }),
  })
}

export interface ProposeCategoryPayload {
  /** Name for the proposed category; falls back to sender, then title. */
  suggested_name?: string
  /** Optional parent category slug. */
  parent_slug?: string | null
  /** Park the document in "sonstiges" until an admin decides (default true). */
  move_to_sonstiges?: boolean
}

/** "No category fits — propose a new one." Files an admin category suggestion. */
export function proposeCategory(id: number, payload: ProposeCategoryPayload = {}) {
  return apiFetch<DocumentDetail>(`/documents/${id}/propose-category`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
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

// ─── Selection-basket batch operations (issue #736) ──────────────────────

export interface BatchAffectedResponse {
  affected_documents: number
}

export interface BatchUpdateAttributesPayload {
  document_ids: number[]
  /** New category slug; `null` clears the category. Omit to leave untouched. */
  category_slug?: string | null
  /** New document date (`YYYY-MM-DD`); `null` clears it. Omit to leave untouched. */
  doc_date?: string | null
  /** Approve (`true`) or un-pin (`false`) the AI attribution without edits (#635). */
  attributes_reviewed?: boolean
}

/** Set category and/or document date on many documents (pins the attributes). */
export function batchUpdateDocumentAttributes(payload: BatchUpdateAttributesPayload) {
  return apiFetch<BatchAffectedResponse>(`/documents/batch/attributes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface BatchUpdateTaxPayload {
  document_ids: number[]
  tax_relevant: boolean
  /** Required when `tax_relevant=true`. */
  tax_year?: number | null
  /** Replaces every section assignment; required non-empty when relevant. */
  tax_sections?: string[]
}

/** Set the tax metadata on many documents (sets `tax_reviewed`). */
export function batchUpdateDocumentTax(payload: BatchUpdateTaxPayload) {
  return apiFetch<BatchAffectedResponse>(`/documents/batch/tax`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface BatchUpdateSubjectPersonsPayload {
  document_ids: number[]
  /** Subject-person ids to link (as user-curated) on every document. */
  add_ids?: number[]
  /** Subject-person ids to unlink from every document. */
  remove_ids?: number[]
}

/** Add/remove Bezugsperson links on many documents. */
export function batchUpdateDocumentSubjectPersons(payload: BatchUpdateSubjectPersonsPayload) {
  return apiFetch<BatchAffectedResponse>(`/documents/batch/subject-persons`, {
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

export type ReclassifyAllMode = 'classify_only' | 'full' | 'resume'

export function reclassifyAllDocuments(mode: ReclassifyAllMode) {
  return apiFetch<{ queued: number; skipped_encrypted?: number; status_breakdown?: Record<string, number> }>('/documents/reclassify-all', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })
}

export interface RelocateAllDocumentsResponse {
  processed: number
  moved: number
  failed: number
}

export function relocateAllDocuments() {
  return apiFetch<RelocateAllDocumentsResponse>('/documents/relocate-all', {
    method: 'POST',
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
 * Decrypt a password-protected document and store it unencrypted. The
 * password is sent once to the backend (qpdf decrypt) and never stored;
 * afterwards the document is re-processed and no longer asks for a password.
 * Returns the refreshed document detail.
 */
export function unlockDocument(id: number, password: string) {
  return apiFetch<DocumentDetail>(`/documents/${id}/unlock`, {
    method: 'POST',
    body: JSON.stringify({ id, password }),
  })
}

/**
 * Drop a document's `failed` state without re-running the pipeline — for when
 * the file is fine and only the automatic classification wasn't, so the user
 * fills the metadata in by hand and marks the document done. Returns the
 * refreshed document detail.
 */
export function dismissDocumentError(id: number) {
  return apiFetch<DocumentDetail>(`/documents/${id}/dismiss-error`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

export function replaceDocumentFile(id: number, file: File, signal?: AbortSignal) {
  return apiFetch<{ success: boolean }>(`/documents/${id}/replace-file`, {
    method: 'POST',
    body: file,
    signal,
    headers: {
      'Content-Type': file.type || 'application/pdf',
      'X-File-Name': encodeURIComponent(file.name),
    },
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

/**
 * Download a document as a file. The backend serves a searchable
 * (OCR-layered) PDF when the original lacked a text layer, building it on
 * demand for documents imported before that feature existed — so the
 * downloaded file is always selectable. Triggers a browser "Save as".
 */
export async function downloadDocument(id: number, filename: string): Promise<void> {
  const token = localStorage.getItem('auth_token')
  const res = await fetch(`${API_BASE_URL}/documents/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Download ${id}: HTTP ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename || `dokument-${id}.pdf`
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
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
  tax_reviewed?: boolean
}

export function listTaxYears() {
  return apiFetch<TaxYearsResponse>('/documents/tax/years')
}

export function listTaxDocuments(
  params: {
    year?: number
    section?: string
    review_needed?: boolean
    /**
     * Omitted = your own tax return (documents routed into a Bezugsperson's
     * own return are excluded). Pass a subject-person id to browse exactly
     * that person's Steuerakte.
     */
    tax_return_person?: number
  } = {},
) {
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

export type RelationKind = 'self' | 'spouse' | 'child' | 'parent' | 'sibling' | 'ward' | 'other'
export type CostBearer = 'user' | 'person' | 'unknown'
export type AssessmentType = 'zusammen' | 'einzeln' | 'unknown'

export interface SubjectPerson {
  id: number
  full_name: string
  relation_tag: string
  relation_kind: RelationKind
  birth_date: string | null
  in_household: boolean
  tax_cost_bearer: CostBearer
  requires_tax_review: boolean
  requires_tax_review_override: boolean | null
  own_tax_return_from_tax_year: number | null
  created_at: string
  updated_at: string
}

export interface AssessmentSetting {
  id: number
  assessment_type: AssessmentType
  valid_from_tax_year: number | null
  created_at: string
  updated_at: string
}

export function listSubjectPersons() {
  return apiFetch<{ items: SubjectPerson[] }>('/documents/subject-persons')
}

export function createSubjectPerson(input: {
  full_name: string
  relation_tag: string
  relation_kind?: string
  birth_date?: string | null
  in_household?: boolean
  tax_cost_bearer?: string
  requires_tax_review?: boolean
  requires_tax_review_override?: boolean | null
  own_tax_return_from_tax_year?: number | null
}) {
  return apiFetch<SubjectPerson>('/documents/subject-persons', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateSubjectPerson(
  id: number,
  patch: {
    full_name?: string
    relation_tag?: string
    relation_kind?: string
    birth_date?: string | null
    in_household?: boolean
    tax_cost_bearer?: string
    requires_tax_review?: boolean
    requires_tax_review_override?: boolean | null
    own_tax_return_from_tax_year?: number | null
  },
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

// ─── Assessment settings ────────────────────────────────────────────────

export function listAssessmentSettings() {
  return apiFetch<{ items: AssessmentSetting[] }>('/documents/assessment-settings')
}

export function upsertAssessmentSetting(input: {
  assessment_type: string
  valid_from_tax_year?: number | null
}) {
  return apiFetch<AssessmentSetting>('/documents/assessment-settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteAssessmentSetting(id: number) {
  return apiFetch<{ success: boolean }>(`/documents/assessment-settings/${id}`, {
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

// ─── Hint suggestions (mined from reviewed docs) ────────────────────────────

export type HintSuggestionKind = 'tax-section' | 'category'

export interface HintSuggestion {
  id: number
  kind: HintSuggestionKind
  target_slug: string
  draft_hint: string
  rationale: string | null
  example_document_ids: number[]
  status: CategorySuggestionStatus
  created_at: string | null
  updated_at: string | null
}

export function listHintSuggestions(
  status: CategorySuggestionStatus = 'open',
  kind?: HintSuggestionKind,
) {
  const params: Record<string, string> = { status }
  if (kind) params.kind = kind
  return apiFetch<{ items: HintSuggestion[] }>(
    `/document-hint-suggestions${buildQuery(params)}`,
  )
}

export function acceptHintSuggestion(id: number) {
  return apiFetch<{ success: boolean }>(`/document-hint-suggestions/${id}/accept`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

export function rejectHintSuggestion(id: number) {
  return apiFetch<{ success: boolean }>(`/document-hint-suggestions/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

// ─── Work-item basket & follow-ups ("Wiedervorlage", issue #750) ─────────────

export interface DocumentBasketResponse {
  items: DocumentSummary[]
  total: number
}

export interface DocumentFollowUp {
  document: DocumentSummary
  follow_up_date: string
  note: string | null
  created_at: string
}

/** The current user's work-item basket: review-worthy, un-snoozed documents. */
export function getDocumentBasket(params: { limit?: number; offset?: number } = {}) {
  return apiFetch<DocumentBasketResponse>(
    `/documents/basket${buildQuery(params as Record<string, unknown>)}`,
  )
}

/** Every pending follow-up for the current user (the "Später" list). */
export function listDocumentFollowUps() {
  return apiFetch<{ items: DocumentFollowUp[] }>('/documents/follow-ups')
}

/** Schedule (or reschedule) a follow-up for one or more documents. */
export function setDocumentFollowUp(payload: {
  document_ids: number[]
  follow_up_date: string
  note?: string | null
}) {
  return apiFetch<{ scheduled: number }>('/documents/follow-ups', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** Cancel a follow-up, returning the document straight to the basket. */
export function deleteDocumentFollowUp(documentId: number) {
  return apiFetch<{ removed: boolean }>(`/documents/follow-ups/${documentId}`, {
    method: 'DELETE',
  })
}
