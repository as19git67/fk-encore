/**
 * Typed client for the Sammelmappen endpoints in the `documents` service.
 *
 * Mirrors the DTOs in `documents/collections.ts`. The export is deliberately
 * fetched as a `File` rather than navigated to: on iOS the native share sheet
 * needs the bytes in hand before the tap handler runs (see utils/shareFile).
 */

import { API_BASE_URL, apiFetch } from './client'
import type { DocumentStatus, DocumentVisibility } from './documents'

export type CollectionKind = 'manual' | 'dossier' | 'basket' | 'rule'

/** What a dossier takes in (#1480); every part optional, see documents/dossiers.ts. */
export interface CollectionRule {
  correspondent_slug?: string | null
  /** Normalised: letters and digits only, upper-cased. */
  reference_numbers?: string[]
  source_folder_prefix?: string | null
  /** Documents a person took out; the rule leaves them alone. */
  excluded_document_ids?: number[]
}

/** One key of a collection's automatic order (documents/collection-sort.ts). */
export interface CollectionSortKey {
  field: 'correspondent' | 'title' | 'doc_date'
  dir: 'asc' | 'desc'
}

/** The rule as typed; the server normalises it. */
export interface CollectionRuleInput {
  correspondent_slug?: string | null
  reference_numbers?: string[] | null
  source_folder_prefix?: string | null
}

export interface DocumentCollection {
  id: number
  title: string
  notes: string | null
  summary: string | null
  /** True while the background job still owes this collection a new summary. */
  summary_stale: boolean
  summary_error: string | null
  summary_generated_at: string | null
  include_cover: boolean
  include_toc: boolean
  include_summary: boolean
  visibility: DocumentVisibility
  group_id: number | null
  /** 'dossier' when a rule fills the folder by itself (#1480). */
  kind: CollectionKind
  rule: CollectionRule | null
  /** Automatic order, up to three keys; null = the order set by dragging. */
  sort_order: CollectionSortKey[] | null
  created_at: string | null
  updated_at: string | null
  /** Documents in the folder, switched on or off. */
  item_count: number
  /** Documents that would actually reach the PDF. */
  included_count: number
  /** True when the caller may share, rename away or delete this collection. */
  can_administer: boolean
}

/**
 * A rectangle blacked out in the folder's PDF, relative to the page as shown
 * (0..1, origin top left). The document itself is never changed.
 */
export interface PageRedaction {
  /** 1-based page number. */
  page: number
  x: number
  y: number
  w: number
  h: number
}

export interface DocumentCollectionItem {
  document_id: number
  position: number
  included: boolean
  /** 1-based page numbers left out of the PDF. */
  excluded_pages: number[]
  redactions: PageRedaction[]
  title: string | null
  original_filename: string
  mime_type: string
  sender: string | null
  doc_date: string | null
  category_slug: string | null
  status: DocumentStatus
  pages_total: number | null
  visibility: DocumentVisibility
  group_id: number | null
  /** 'rule' when the dossier's rule put it in, 'user' when a person did. */
  joined_by: 'user' | 'rule'
}

export interface DocumentCollectionDetail extends DocumentCollection {
  items: DocumentCollectionItem[]
}

export interface DocumentCollectionRef {
  id: number
  title: string
  included: boolean
}

/**
 * Every Sammelmappe the caller may read. `q` filters on the folder's own words
 * — title, note, summary — never on the words of its member documents: a
 * folder that matched because one of forty documents mentions the term would
 * be a result nobody can explain, and the document itself is already in the
 * document results.
 */
export function listCollections(q?: string): Promise<{ items: DocumentCollection[] }> {
  const qs = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''
  return apiFetch<{ items: DocumentCollection[] }>(`/document-collections${qs}`)
}

export function getCollection(id: number): Promise<DocumentCollectionDetail> {
  return apiFetch<DocumentCollectionDetail>(`/document-collections/${id}`)
}

export interface CreateCollectionPayload {
  title: string
  notes?: string | null
  visibility?: DocumentVisibility
  group_id?: number | null
  document_ids?: number[]
  kind?: CollectionKind
  rule?: CollectionRuleInput | null
}

export function createCollection(
  payload: CreateCollectionPayload,
): Promise<DocumentCollectionDetail> {
  return apiFetch<DocumentCollectionDetail>('/document-collections', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface UpdateCollectionPayload {
  title?: string
  notes?: string | null
  summary?: string | null
  include_cover?: boolean
  include_toc?: boolean
  include_summary?: boolean
  visibility?: DocumentVisibility
  group_id?: number | null
  kind?: CollectionKind
  rule?: CollectionRuleInput | null
  /** Up to three keys, or null for the order set by dragging. */
  sort_order?: CollectionSortKey[] | null
}

/** Run a dossier's rule over the corpus now. */
export function applyCollectionRule(id: number): Promise<{ added: number; removed: number }> {
  return apiFetch<{ added: number; removed: number }>(`/document-collections/${id}/apply-rule`, {
    method: 'POST',
  })
}

export function updateCollection(
  id: number,
  payload: UpdateCollectionPayload,
): Promise<DocumentCollectionDetail> {
  return apiFetch<DocumentCollectionDetail>(`/document-collections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteCollection(id: number): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(`/document-collections/${id}`, { method: 'DELETE' })
}

export function addCollectionDocuments(
  id: number,
  documentIds: number[],
): Promise<DocumentCollectionDetail> {
  return apiFetch<DocumentCollectionDetail>(`/document-collections/${id}/documents`, {
    method: 'POST',
    body: JSON.stringify({ document_ids: documentIds }),
  })
}

export function removeCollectionDocument(
  id: number,
  documentId: number,
): Promise<DocumentCollectionDetail> {
  return apiFetch<DocumentCollectionDetail>(
    `/document-collections/${id}/documents/${documentId}`,
    { method: 'DELETE' },
  )
}

/** Send the whole order; ids left out keep their relative position at the end. */
export function reorderCollection(
  id: number,
  documentIds: number[],
): Promise<DocumentCollectionDetail> {
  return apiFetch<DocumentCollectionDetail>(`/document-collections/${id}/order`, {
    method: 'PUT',
    body: JSON.stringify({ document_ids: documentIds }),
  })
}

export interface UpdateCollectionItemPayload {
  included?: boolean
  excluded_pages?: number[]
  redactions?: PageRedaction[]
}

export function updateCollectionItem(
  id: number,
  documentId: number,
  payload: UpdateCollectionItemPayload,
): Promise<DocumentCollectionDetail> {
  return apiFetch<DocumentCollectionDetail>(
    `/document-collections/${id}/documents/${documentId}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  )
}

/** Which Sammelmappen a document is currently in. */
export function listCollectionsForDocument(
  documentId: number,
): Promise<{ items: DocumentCollectionRef[] }> {
  return apiFetch<{ items: DocumentCollectionRef[] }>(`/documents/${documentId}/collections`)
}

/** Filename the export is offered under — mirrors the backend's own rule. */
export function collectionPdfFilename(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return `${base || 'sammelmappe'}.pdf`
}

export interface CollectionPdf {
  file: File
  /** Object URL for the download fallback; revoke it when done. */
  url: string
  /** How many members contributed nothing (unreadable, or fully deselected). */
  skipped: number
}

/**
 * How the caller's PDF of a collection stands: built in the background and
 * kept until the folder changes, which throws it away ('none' again).
 */
export interface CollectionExport {
  status: 'none' | 'running' | 'done' | 'failed'
  started_at: string | null
  finished_at: string | null
  error: string | null
  filename: string | null
  page_count: number | null
  size_bytes: number | null
  /** Members that did not make it into the file. */
  skipped_count: number
}

/** Start building the PDF on the server, or join the build already running. */
export function startCollectionExport(id: number): Promise<CollectionExport> {
  return apiFetch<CollectionExport>(`/document-collections/${id}/export`, { method: 'POST' })
}

export function getCollectionExport(id: number): Promise<CollectionExport> {
  return apiFetch<CollectionExport>(`/document-collections/${id}/export`)
}

/**
 * Fetch the kept PDF.
 *
 * Returns a `File` so the caller can hand it straight to `navigator.share`
 * inside a later tap handler — awaiting the fetch there would cost the
 * transient activation iOS requires, and the share would be rejected.
 */
export async function fetchCollectionPdf(
  id: number,
  title: string,
): Promise<CollectionPdf> {
  const token = localStorage.getItem('auth_token')
  const res = await fetch(`${API_BASE_URL}/document-collections/${id}/export/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    throw new Error((await res.text()) || `Sammelmappe ${id}: HTTP ${res.status}`)
  }
  const skipped = Number(res.headers.get('X-Collection-Skipped') ?? '0')
  const blob = await res.blob()
  const filename = collectionPdfFilename(title)
  return {
    file: new File([blob], filename, { type: 'application/pdf' }),
    url: URL.createObjectURL(blob),
    skipped: Number.isFinite(skipped) ? skipped : 0,
  }
}

// ─── Collections of every type (#1548) ─────────────────────────────────────

/** Everything a collection can hold. */
export type CollectionEntityType =
  | 'document'
  | 'photo'
  | 'album'
  | 'transaction'
  | 'security'
  | 'meter'
  | 'meter_reading'

export interface MemberRef {
  entity_type: CollectionEntityType
  entity_id: number
}

export interface CollectionSummary {
  id: number
  name: string
  description: string | null
  /** The one type the collection holds, or null for any. */
  entity_type: CollectionEntityType | null
  kind: CollectionKind
  visibility: 'private' | 'group'
  group_id: number | null
  archived_at: string | null
  created_by: 'user' | 'assistant'
  created_at: string
  updated_at: string
  favourite: boolean
  last_opened_at: string | null
  counts: Partial<Record<CollectionEntityType, number>>
  total: number
  can_administer: boolean
  /** The membership rule of a rule collection (#1548, stage 5); null otherwise. */
  rule: MemberRule | null
}

export interface CollectionMember extends MemberRef {
  title: string
  subtitle: string | null
  date: string | null
  amount: string | null
  currency: string | null
  joined_by: 'user' | 'rule'
  added_at: string
}

export interface CollectionDetail extends CollectionSummary {
  members: CollectionMember[]
  /** Members stored that the caller may not open. */
  hidden_count: number
}

export interface ListAllCollectionsQuery {
  q?: string
  type?: CollectionEntityType | 'mixed'
  holds?: CollectionEntityType
  archived?: boolean
  favourite?: boolean
  sort?: 'last_opened' | 'updated' | 'name' | 'count'
  dir?: 'asc' | 'desc'
}

export function listAllCollections(query: ListAllCollectionsQuery = {}): Promise<{ items: CollectionSummary[] }> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const qs = params.toString()
  return apiFetch(`/collections${qs ? `?${qs}` : ''}`)
}

export function getAnyCollection(id: number): Promise<CollectionDetail> {
  return apiFetch(`/collections/${id}`)
}

export function createAnyCollection(payload: {
  name: string
  description?: string | null
  entity_type?: CollectionEntityType | null
  visibility?: 'private' | 'group'
  group_id?: number | null
  members?: MemberRef[]
}): Promise<CollectionDetail> {
  return apiFetch('/collections', { method: 'POST', body: JSON.stringify(payload) })
}

export function addAnyCollectionMembers(
  id: number,
  members: MemberRef[],
): Promise<{ added: number; collection: CollectionDetail }> {
  return apiFetch(`/collections/${id}/members`, { method: 'POST', body: JSON.stringify({ members }) })
}

export function removeAnyCollectionMember(id: number, ref: MemberRef): Promise<CollectionDetail> {
  return apiFetch(`/collections/${id}/members/${ref.entity_type}/${ref.entity_id}`, { method: 'DELETE' })
}

export function markCollectionOpened(id: number): Promise<{ ok: boolean }> {
  return apiFetch(`/collections/${id}/opened`, { method: 'POST' })
}

export function collectionsOfItem(
  ref: MemberRef,
): Promise<{ items: Array<Pick<CollectionSummary, 'id' | 'name' | 'entity_type' | 'archived_at'>> }> {
  return apiFetch(`/collections/of/${ref.entity_type}/${ref.entity_id}`)
}

// ─── Basket (#1548) ─────────────────────────────────────────────────────────

export function getBasket(): Promise<CollectionDetail> {
  return apiFetch('/collections/basket')
}

export function addToBasket(members: MemberRef[]): Promise<{ added: number; collection: CollectionDetail }> {
  return apiFetch('/collections/basket/members', { method: 'POST', body: JSON.stringify({ members }) })
}

export function removeFromBasket(members: MemberRef[]): Promise<CollectionDetail> {
  return apiFetch('/collections/basket/remove', { method: 'POST', body: JSON.stringify({ members }) })
}

export function clearBasket(type?: CollectionEntityType): Promise<CollectionDetail> {
  return apiFetch(`/collections/basket/members${type ? `?type=${type}` : ''}`, { method: 'DELETE' })
}

export function saveBasketAsCollection(payload: {
  name: string
  description?: string | null
  keep?: boolean
  type?: CollectionEntityType
}): Promise<CollectionDetail> {
  return apiFetch('/collections/basket/save', { method: 'POST', body: JSON.stringify(payload) })
}

/** What one item of each type is called, for counts and headings. */
export const ENTITY_LABELS: Record<CollectionEntityType, { singular: string; plural: string; icon: string }> = {
  document: { singular: 'Dokument', plural: 'Dokumente', icon: 'pi pi-file' },
  photo: { singular: 'Foto', plural: 'Fotos', icon: 'pi pi-image' },
  album: { singular: 'Album', plural: 'Alben', icon: 'pi pi-images' },
  transaction: { singular: 'Buchung', plural: 'Buchungen', icon: 'pi pi-wallet' },
  security: { singular: 'Wertpapier', plural: 'Wertpapiere', icon: 'pi pi-chart-line' },
  meter: { singular: 'Zähler', plural: 'Zähler', icon: 'pi pi-gauge' },
  meter_reading: { singular: 'Zählerstand', plural: 'Zählerstände', icon: 'pi pi-pencil' },
}

/** "3 Fotos, 1 Buchung" — the parts in a fixed order, empty types left out. */
export function describeCounts(
  counts: Partial<Record<CollectionEntityType, number>>,
  except?: CollectionEntityType,
): string {
  return (Object.keys(ENTITY_LABELS) as CollectionEntityType[])
    .filter((type) => type !== except && (counts[type] ?? 0) > 0)
    .map((type) => {
      const n = counts[type]!
      const label = ENTITY_LABELS[type]
      return `${n} ${n === 1 ? label.singular : label.plural}`
    })
    .join(', ')
}

export function updateAnyCollection(
  id: number,
  patch: { name?: string; description?: string | null; archived?: boolean; favourite?: boolean },
): Promise<CollectionDetail> {
  return apiFetch(`/collections/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteAnyCollection(id: number): Promise<{ deleted: boolean }> {
  return apiFetch(`/collections/${id}`, { method: 'DELETE' })
}

// ─── Rules (#1548, stage 5) ────────────────────────────────────────────────

export interface TransactionRuleCriteria {
  account_ids?: number[]
  tags?: string[]
  text?: string
  from?: string
  to?: string
  tax_relevant?: boolean
  amount_min?: number
  amount_max?: number
  direction?: 'in' | 'out'
}

export type MemberRule =
  | { type: 'photo'; filter: Record<string, string | number | boolean>; excluded_ids?: number[] }
  | { type: 'transaction'; criteria: TransactionRuleCriteria; excluded_ids?: number[] }
  | { type: 'security'; criteria: { account_ids?: number[]; statuses?: Array<'confirmed' | 'proposed' | 'ignored'> }; excluded_ids?: number[] }
  | { type: 'meter'; criteria: { meter_types?: Array<'electricity' | 'water' | 'gas' | 'operating_hours'>; location?: string }; excluded_ids?: number[] }

export type MemberRuleInput =
  | { type: 'photo'; filter: Record<string, string | number | boolean> }
  | { type: 'transaction'; criteria: TransactionRuleCriteria }
  | { type: 'security'; criteria: { account_ids?: number[]; statuses?: Array<'confirmed' | 'proposed' | 'ignored'> } }
  | { type: 'meter'; criteria: { meter_types?: Array<'electricity' | 'water' | 'gas' | 'operating_hours'>; location?: string } }

export interface RuleCollectionResponse {
  collection: CollectionDetail
  applied: { added: number; removed: number }
}

export function createRuleCollection(payload: {
  name: string
  description?: string | null
  rule: MemberRuleInput
}): Promise<RuleCollectionResponse> {
  return apiFetch('/collections/rule', { method: 'POST', body: JSON.stringify(payload) })
}

export function setCollectionRule(id: number, rule: MemberRuleInput | null): Promise<RuleCollectionResponse> {
  return apiFetch(`/collections/${id}/rule`, { method: 'PUT', body: JSON.stringify({ rule }) })
}

export function applyCollectionRuleNow(id: number): Promise<RuleCollectionResponse> {
  return apiFetch(`/collections/${id}/apply-rule`, { method: 'POST' })
}

export function createAlbumFromCollection(id: number, name: string): Promise<{ album_id: number; photos: number }> {
  return apiFetch(`/collections/${id}/to-album`, { method: 'POST', body: JSON.stringify({ name }) })
}

// ─── Exports (#1548, stage 6) ──────────────────────────────────────────────

export type TableFormat = 'csv' | 'xlsx' | 'pdf'

export const TRANSACTION_EXPORT_COLUMNS = [
  'booking_date',
  'value_date',
  'account',
  'counterparty',
  'counterparty_iban',
  'purpose',
  'amount',
  'currency',
  'tags',
  'notice',
] as const
export type TransactionExportColumn = (typeof TRANSACTION_EXPORT_COLUMNS)[number]

export const TRANSACTION_COLUMN_LABELS: Record<TransactionExportColumn, string> = {
  booking_date: 'Buchungstag',
  value_date: 'Valuta',
  account: 'Konto',
  counterparty: 'Gegenseite',
  counterparty_iban: 'IBAN Gegenseite',
  purpose: 'Verwendungszweck',
  amount: 'Betrag',
  currency: 'Währung',
  tags: 'Tags',
  notice: 'Notiz',
}

export interface PhotoExportOptions {
  size: 'original' | 'large'
  strip_metadata: boolean
}

export interface ExportOptions {
  document: { format: 'pdf' | 'zip' }
  transaction: {
    format: TableFormat
    columns: TransactionExportColumn[]
    group_by_account: boolean
    account_order: number[]
  }
  photo: PhotoExportOptions
  album: PhotoExportOptions
  security: { format: TableFormat }
  meter: { format: TableFormat; from: string | null; to: string | null }
  always_zip: boolean
}

/** Meters and single readings are exported together. */
export type ExportGroup = Exclude<CollectionEntityType, 'meter_reading'>

export interface ExportProfile {
  id: number
  name: string
  options: ExportOptions
  updated_at: string
}

export interface ExportSetup {
  groups: Partial<Record<ExportGroup, number>>
  defaults: ExportOptions
  profiles: ExportProfile[]
  accounts: Array<{ id: number; label: string }>
}

export interface ExportSkip {
  entity_type: CollectionEntityType
  entity_id: number
  reason: string
}

export interface ExportRun {
  id: number
  collection_id: number
  status: 'running' | 'done' | 'failed'
  profile_id: number | null
  filename: string | null
  mime_type: string | null
  size_bytes: number | null
  item_count: number
  skipped: ExportSkip[]
  error: string | null
  document_id: number | null
  started_at: string
  finished_at: string | null
  expires_at: string
}

export const EXPORT_SKIP_REASONS: Record<string, string> = {
  switched_off: 'in der Mappe ausgeschaltet',
  file_missing: 'Datei fehlt',
  redacted: 'hat Schwärzungen, nur im PDF',
  unreadable: 'nicht lesbar',
  not_visible: 'nicht sichtbar',
  no_pages_selected: 'keine Seite ausgewählt',
  unsupported_type: 'Dateityp nicht unterstützt',
}

export function getExportSetup(id: number): Promise<ExportSetup> {
  return apiFetch(`/collections/${id}/export-setup`)
}

export function saveExportProfile(id: number, name: string, options: ExportOptions): Promise<ExportProfile> {
  return apiFetch(`/collections/${id}/export-profiles`, { method: 'POST', body: JSON.stringify({ name, options }) })
}

export function deleteExportProfile(id: number, profileId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/collections/${id}/export-profiles/${profileId}`, { method: 'DELETE' })
}

export function startCollectionExportRun(
  id: number,
  request: { options: ExportOptions } | { profile_id: number },
): Promise<ExportRun> {
  return apiFetch(`/collections/${id}/exports`, { method: 'POST', body: JSON.stringify(request) })
}

export function listCollectionExportRuns(id: number): Promise<{ items: ExportRun[] }> {
  return apiFetch(`/collections/${id}/exports`)
}

export function getCollectionExportRun(exportId: number): Promise<ExportRun> {
  return apiFetch(`/collections/exports/${exportId}`)
}

export function deleteCollectionExportRun(exportId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/collections/exports/${exportId}`, { method: 'DELETE' })
}

export function saveCollectionExportAsDocument(
  exportId: number,
): Promise<{ document_id: number; already_existed: boolean }> {
  return apiFetch(`/collections/exports/${exportId}/document`, { method: 'POST' })
}

/** The finished file as a `File`, for a download link or the share sheet. */
export async function fetchCollectionExportFile(run: ExportRun): Promise<File> {
  const token = localStorage.getItem('auth_token')
  const res = await fetch(`${API_BASE_URL}/collections/exports/${run.id}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error((await res.text()) || `Export ${run.id}: HTTP ${res.status}`)
  const blob = await res.blob()
  return new File([blob], run.filename ?? 'export', { type: run.mime_type ?? blob.type })
}

// ─── Sending (#1548, stage 7) ──────────────────────────────────────────────

export interface ExportEntry {
  name: string
  size: number
}

export interface CollectionSend {
  id: number
  export_id: number | null
  recipients: string[]
  mode: 'attachment' | 'items' | 'link'
  filename: string | null
  status: 'sent' | 'failed'
  error: string | null
  /** The From address the mail carried. */
  sender: string | null
  sent_at: string
  sent_by: string | null
}

export interface CollectionSendsResponse {
  items: CollectionSend[]
  mail_configured: boolean
  /** The signed-in user's address. */
  sender_email: string | null
  /** The app's address: the sender unless the user chooses their own. */
  system_sender: string
  /** The user's address shares the app's domain and may be the sender instead. */
  self_sender_allowed: boolean
}

export function listExportEntries(exportId: number): Promise<{ items: ExportEntry[]; single_files_allowed: boolean }> {
  return apiFetch(`/collections/exports/${exportId}/entries`)
}

/** One file out of an export ZIP, for the share sheet. */
export async function fetchExportEntryFile(exportId: number, name: string): Promise<File> {
  const token = localStorage.getItem('auth_token')
  const res = await fetch(`${API_BASE_URL}/collections/exports/${exportId}/entry?name=${encodeURIComponent(name)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error((await res.text()) || `Datei ${name}: HTTP ${res.status}`)
  const blob = await res.blob()
  return new File([blob], name.split('/').pop() || name, { type: blob.type || 'application/octet-stream' })
}

export function createExportLink(exportId: number): Promise<{ url: string; expires_at: string }> {
  return apiFetch(`/collections/exports/${exportId}/link`, { method: 'POST' })
}

export function sendExportByMail(
  exportId: number,
  to: string[],
  message: string | null,
  singleFiles: boolean,
  fromSelf = false,
): Promise<{ mode: CollectionSend['mode']; send_id: number }> {
  return apiFetch(`/collections/exports/${exportId}/send`, {
    method: 'POST',
    body: JSON.stringify({ to, message, single_files: singleFiles, from_self: fromSelf }),
  })
}

export function listCollectionSends(id: number): Promise<CollectionSendsResponse> {
  return apiFetch(`/collections/${id}/sends`)
}

// ─── Scheduled exports (#1548, stage 9) ────────────────────────────────────

export type ScheduleCadence = 'weekly' | 'monthly' | 'yearly'

export interface CollectionSchedule {
  id: number
  collection_id: number
  profile_id: number | null
  profile_name: string | null
  cadence: ScheduleCadence
  weekday: number | null
  day: number | null
  month: number | null
  scope: 'all' | 'period'
  save_as_document: boolean
  recipients: string[]
  /** The From address of its mails; `null` without recipients. */
  sender: string | null
  /** The owner chose their own address as sender. */
  send_as_self: boolean
  single_files: boolean
  message: string | null
  enabled: boolean
  next_run_at: string
  last_run_at: string | null
  last_status: 'done' | 'failed' | 'skipped' | null
  last_error: string | null
  last_export_id: number | null
  failures: number
  owner_name: string | null
  can_edit: boolean
}

export interface CreateScheduleInput {
  cadence: ScheduleCadence
  weekday?: number | null
  day?: number | null
  month?: number | null
  scope: 'all' | 'period'
  profile_id?: number | null
  options?: ExportOptions
  save_as_document?: boolean
  recipients?: string[]
  single_files?: boolean
  message?: string | null
  /** From the owner's own address instead of the app's (same domain only). */
  from_self?: boolean
}

export function listCollectionSchedules(id: number): Promise<{ items: CollectionSchedule[] }> {
  return apiFetch(`/collections/${id}/schedules`)
}

export function createCollectionSchedule(id: number, input: CreateScheduleInput): Promise<CollectionSchedule> {
  return apiFetch(`/collections/${id}/schedules`, { method: 'POST', body: JSON.stringify(input) })
}

export function setCollectionScheduleEnabled(scheduleId: number, enabled: boolean): Promise<CollectionSchedule> {
  return apiFetch(`/collections/schedules/${scheduleId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
}

export function deleteCollectionSchedule(scheduleId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/collections/schedules/${scheduleId}`, { method: 'DELETE' })
}

export function runCollectionScheduleNow(
  scheduleId: number,
): Promise<{ schedule: CollectionSchedule; run: ExportRun | null }> {
  return apiFetch(`/collections/schedules/${scheduleId}/run`, { method: 'POST' })
}

// ─── Anonymous share links (#1548, stage 8) ────────────────────────────────

export type LinkExpiry = '7d' | '30d' | '90d' | 'never'

export interface CollectionPublicLink {
  id: number
  collection_id: number
  token: string
  created_at: string
  expires_at: string | null
}

export interface PublicPhoto {
  id: number
  taken_on: string | null
}

export interface PublicAlbum {
  id: number
  title: string
  photo_ids: number[]
}

export interface PublicDocument {
  id: number
  title: string
  date: string | null
  mime_type: string
}

export interface PublicCollection {
  title: string
  description: string | null
  expires_at: string | null
  photos: PublicPhoto[]
  albums: PublicAlbum[]
  documents: PublicDocument[]
  withheld: Array<{ kind: string; count: number }>
}

export function listCollectionPublicLinks(id: number): Promise<{ items: CollectionPublicLink[] }> {
  return apiFetch(`/collections/${id}/public-links`)
}

export function createCollectionPublicLink(id: number, expiresIn: LinkExpiry): Promise<CollectionPublicLink> {
  return apiFetch(`/collections/${id}/public-links`, { method: 'POST', body: JSON.stringify({ expires_in: expiresIn }) })
}

export function disableCollectionPublicLink(linkId: number): Promise<{ ok: boolean }> {
  return apiFetch(`/collections/public-links/${linkId}`, { method: 'DELETE' })
}

export function getPublicCollection(token: string): Promise<PublicCollection> {
  return apiFetch(`/collections/public/${encodeURIComponent(token)}`)
}

/** A photo behind a link, re-encoded by the server without metadata. */
export function publicCollectionPhotoUrl(token: string, photoId: number, width?: number): string {
  const w = width ? `?w=${width}` : ''
  return `${API_BASE_URL}/collections/public/${encodeURIComponent(token)}/photos/${photoId}${w}`
}

export function publicCollectionDocumentUrl(token: string, documentId: number): string {
  return `${API_BASE_URL}/collections/public/${encodeURIComponent(token)}/documents/${documentId}`
}
