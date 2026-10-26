/**
 * Photo books (documentation/plans/fotobuch.md, issue #1729). The server lays
 * out the pages and sends each cell as a share of the page, so the editor
 * only draws what it gets.
 */
import { API_BASE_URL, apiFetch, withPhotoAccessParams } from './client'

export type PhotoBookFormat = 'a4-landscape' | 'a4-portrait' | 'square-21' | 'square-30'
export type PhotoBookPageKind = 'opener' | 'photos'
export type PhotoBookExportMode = 'print' | 'home'
/** Who wrote a title or caption, or picked a layout. */
export type PhotoBookTextSource = 'rule' | 'llm' | 'user'
export type PhotoBookAiTask = 'captions' | 'chapters' | 'layouts'

export interface PageRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PhotoBookSlot {
  slot: number
  photo_id: number
  filename: string
  auto_crop: { x: number; y: number } | null
  /** Where the photo goes, without its caption strip. */
  rect: PageRect
  dpi: number | null
  low_dpi: boolean
  caption: string | null
  caption_source: 'llm' | 'user' | null
  /** Where the caption goes; null when the page shows none. */
  caption_rect: PageRect | null
  caption_overlay: boolean
}

export interface PhotoBookPage {
  id: number
  position: number
  chapter_id: number | null
  kind: PhotoBookPageKind
  layout: string
  layout_options: { id: string; name: string }[]
  full_bleed: boolean
  text_rect: PageRect | null
  /** Whether the page shows captions, after the book's setting. */
  captions: boolean
  /** The page's own setting; null follows the book. */
  captions_override: boolean | null
  layout_source: PhotoBookTextSource
  layout_reason: string | null
  slots: PhotoBookSlot[]
}

export interface PhotoBookChapter {
  id: number
  position: number
  title: string
  subtitle: string | null
  starts_at: string | null
  ends_at: string | null
  title_source: PhotoBookTextSource
  title_suggestion: string | null
}

export interface PhotoBookSettings {
  bleed_mm: number
  crop_marks: boolean
  spreads: boolean
  paper_mm: number
  captions: boolean
}

export interface PhotoBookSource {
  kind: 'photos' | 'album'
  photo_ids?: number[]
  album_id?: number
  quality_min?: number | null
  aesthetic_min?: number | null
  without_recognisable_faces?: boolean
  max_photos?: number | null
}

export interface PhotoBook {
  id: number
  title: string
  subtitle: string | null
  format: PhotoBookFormat
  width_mm: number
  height_mm: number
  cover_photo_id: number | null
  cover_filename: string | null
  cover_auto_crop: { x: number; y: number } | null
  settings: PhotoBookSettings
  source: PhotoBookSource
  page_count: number
  photo_count: number
  spine_mm: number
  low_dpi_count: number
  chapters: PhotoBookChapter[]
  pages: PhotoBookPage[]
  created_at: string
  updated_at: string
}

export interface PhotoBookSummary {
  id: number
  title: string
  subtitle: string | null
  format: PhotoBookFormat
  page_count: number
  photo_count: number
  cover_filename: string | null
  updated_at: string
}

export interface PhotoBookFormatOption {
  id: PhotoBookFormat
  name: string
  width_mm: number
  height_mm: number
}

export interface CreatePhotoBookPayload {
  title: string
  subtitle?: string | null
  format?: PhotoBookFormat
  photoIds?: number[]
  albumId?: number
  /** 0..100 */
  qualityMin?: number | null
  /** 0..100 */
  aestheticMin?: number | null
  withoutRecognisableFaces?: boolean
  maxPhotos?: number | null
}

export interface UpdatePhotoBookPayload {
  title?: string
  subtitle?: string | null
  format?: PhotoBookFormat
  coverPhotoId?: number | null
  settings?: Partial<PhotoBookSettings>
}

export interface PhotoBookExportStatus {
  status: 'none' | 'running' | 'done' | 'failed'
  mode?: PhotoBookExportMode
  progress: number
  error?: string
  files: { kind: 'cover' | 'inside' | 'book'; url: string }[]
}

/** The formats as the server knows them, for the create dialog before any book exists. */
export const PHOTO_BOOK_FORMATS: PhotoBookFormatOption[] = [
  { id: 'a4-landscape', name: 'A4 quer', width_mm: 297, height_mm: 210 },
  { id: 'a4-portrait', name: 'A4 hoch', width_mm: 210, height_mm: 297 },
  { id: 'square-21', name: 'Quadrat 21 × 21 cm', width_mm: 210, height_mm: 210 },
  { id: 'square-30', name: 'Quadrat 30 × 30 cm', width_mm: 300, height_mm: 300 },
]

export function listPhotoBooks() {
  return apiFetch<{ books: PhotoBookSummary[]; formats: PhotoBookFormatOption[] }>('/photo-books')
}

export function createPhotoBook(payload: CreatePhotoBookPayload) {
  return apiFetch<PhotoBook>('/photo-books', { method: 'POST', body: JSON.stringify(payload) })
}

export function getPhotoBook(id: number) {
  return apiFetch<PhotoBook>(`/photo-books/${id}`)
}

export function updatePhotoBook(id: number, payload: UpdatePhotoBookPayload) {
  return apiFetch<PhotoBook>(`/photo-books/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
}

export function rebuildPhotoBook(id: number) {
  return apiFetch<PhotoBook>(`/photo-books/${id}/rebuild`, { method: 'POST' })
}

export function deletePhotoBook(id: number) {
  return apiFetch<void>(`/photo-books/${id}`, { method: 'DELETE' })
}

export function updatePhotoBookChapter(id: number, chapterId: number, payload: { title?: string; subtitle?: string | null }) {
  return apiFetch<PhotoBook>(`/photo-books/${id}/chapters/${chapterId}`, { method: 'PATCH', body: JSON.stringify(payload) })
}

export function setPhotoBookPageLayout(id: number, pageId: number, layout: string) {
  return apiFetch<PhotoBook>(`/photo-books/${id}/pages/${pageId}/layout`, { method: 'PUT', body: JSON.stringify({ layout }) })
}

export function removePhotoFromBookPage(id: number, pageId: number, photoId: number) {
  return apiFetch<PhotoBook>(`/photo-books/${id}/pages/${pageId}/photos/${photoId}`, { method: 'DELETE' })
}

export function setPhotoBookPageCaptions(id: number, pageId: number, captions: boolean | null) {
  return apiFetch<PhotoBook>(`/photo-books/${id}/pages/${pageId}/captions`, { method: 'PUT', body: JSON.stringify({ captions }) })
}

export function setPhotoBookCaption(id: number, photoId: number, text: string | null) {
  return apiFetch<PhotoBook>(`/photo-books/${id}/captions/${photoId}`, { method: 'PUT', body: JSON.stringify({ text }) })
}

export function acceptPhotoBookChapterSuggestion(id: number, chapterId: number) {
  return apiFetch<PhotoBook>(`/photo-books/${id}/chapters/${chapterId}/accept-suggestion`, { method: 'POST' })
}

export interface PhotoBookAiJob {
  book_id: number
  status: 'running' | 'done' | 'failed'
  tasks: PhotoBookAiTask[]
  done: number
  total: number
  captions: number
  chapters: number
  layouts: number
  skipped: number
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface PhotoBookAiStatus {
  status: 'none' | PhotoBookAiJob['status']
  job: PhotoBookAiJob | null
}

export function startPhotoBookAi(id: number, tasks: PhotoBookAiTask[], overwrite = false) {
  return apiFetch<PhotoBookAiStatus>(`/photo-books/${id}/ai`, { method: 'POST', body: JSON.stringify({ tasks, overwrite }) })
}

export function getPhotoBookAi(id: number) {
  return apiFetch<PhotoBookAiStatus>(`/photo-books/${id}/ai`)
}

export interface PhotoBookLayoutStats {
  rule: { pages: number; changed: number }
  llm: { pages: number; changed: number }
  llm_differs: number
}

export function getPhotoBookLayoutStats() {
  return apiFetch<PhotoBookLayoutStats>('/photo-books-layout-stats')
}

export function startPhotoBookExport(id: number, mode: PhotoBookExportMode) {
  return apiFetch<PhotoBookExportStatus>(`/photo-books/${id}/export`, { method: 'POST', body: JSON.stringify({ mode }) })
}

export function getPhotoBookExport(id: number) {
  return apiFetch<PhotoBookExportStatus>(`/photo-books/${id}/export`)
}

/** A download link of a finished export. */
export function photoBookFileUrl(url: string): string {
  return `${API_BASE_URL}${url}`
}

/** A photo of the book at preview size. */
export function photoBookThumbUrl(filename: string, width = 480): string {
  return withPhotoAccessParams(`${API_BASE_URL}/photos/file/${filename}?w=${width}`)
}
