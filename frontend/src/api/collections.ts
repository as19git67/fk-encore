/**
 * Typed client for the Sammelmappen endpoints in the `documents` service.
 *
 * Mirrors the DTOs in `documents/collections.ts`. The export is deliberately
 * fetched as a `File` rather than navigated to: on iOS the native share sheet
 * needs the bytes in hand before the tap handler runs (see utils/shareFile).
 */

import { API_BASE_URL, apiFetch } from './client'
import type { DocumentStatus, DocumentVisibility } from './documents'

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
  created_at: string | null
  updated_at: string | null
  /** Documents in the folder, switched on or off. */
  item_count: number
  /** Documents that would actually reach the PDF. */
  included_count: number
  /** True when the caller may share, rename away or delete this collection. */
  can_administer: boolean
}

export interface DocumentCollectionItem {
  document_id: number
  position: number
  included: boolean
  /** 1-based page numbers left out of the PDF. */
  excluded_pages: number[]
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
}

export interface DocumentCollectionDetail extends DocumentCollection {
  items: DocumentCollectionItem[]
}

export interface DocumentCollectionRef {
  id: number
  title: string
  included: boolean
}

export function listCollections(): Promise<{ items: DocumentCollection[] }> {
  return apiFetch<{ items: DocumentCollection[] }>('/document-collections')
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
 * Build and fetch the collection's PDF.
 *
 * Returns a `File` so the caller can hand it straight to `navigator.share`
 * inside a tap handler — awaiting the fetch there would cost the transient
 * activation iOS requires, and the share would be rejected.
 */
export async function fetchCollectionPdf(
  id: number,
  title: string,
): Promise<CollectionPdf> {
  const token = localStorage.getItem('auth_token')
  const res = await fetch(`${API_BASE_URL}/document-collections/${id}/pdf`, {
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
