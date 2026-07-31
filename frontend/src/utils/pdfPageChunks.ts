/**
 * Chunking helpers for the continuous (scroll-through) PDF viewer.
 *
 * The viewer renders every page of a document one below the other instead of
 * a single page with prev/next controls. Rendering thousands of pages at once
 * would be prohibitive, so the pages are cut into fixed-size chunks and only
 * one chunk is mounted at a time; the toolbar paginates between chunks.
 */

/** Number of pages rendered in one go (issue #919). */
export const PDF_PAGE_CHUNK_SIZE = 25

/** Inclusive 1-based page range covered by a chunk. */
export interface PageChunkRange {
  start: number
  end: number
}

function normalizeSize(size: number): number {
  return Number.isFinite(size) && size >= 1 ? Math.floor(size) : PDF_PAGE_CHUNK_SIZE
}

function normalizeTotal(totalPages: number): number {
  return Number.isFinite(totalPages) && totalPages > 0 ? Math.floor(totalPages) : 0
}

/** How many chunks a document of `totalPages` pages is split into (0 when empty). */
export function chunkCount(totalPages: number, size: number = PDF_PAGE_CHUNK_SIZE): number {
  const total = normalizeTotal(totalPages)
  if (total === 0) return 0
  return Math.ceil(total / normalizeSize(size))
}

/** 0-based index of the chunk holding the given 1-based page number. */
export function chunkForPage(page: number, size: number = PDF_PAGE_CHUNK_SIZE): number {
  const p = Number.isFinite(page) ? Math.floor(page) : 1
  if (p < 1) return 0
  return Math.floor((p - 1) / normalizeSize(size))
}

/** Clamp a chunk index into the valid range for the document. */
export function clampChunkIndex(
  index: number,
  totalPages: number,
  size: number = PDF_PAGE_CHUNK_SIZE,
): number {
  const count = chunkCount(totalPages, size)
  if (count === 0) return 0
  const i = Number.isFinite(index) ? Math.floor(index) : 0
  return Math.min(Math.max(0, i), count - 1)
}

/**
 * Inclusive 1-based page range of a chunk. Returns `{ start: 0, end: 0 }` for
 * an empty document so callers can treat it as "nothing to render".
 */
export function chunkRange(
  index: number,
  totalPages: number,
  size: number = PDF_PAGE_CHUNK_SIZE,
): PageChunkRange {
  const total = normalizeTotal(totalPages)
  if (total === 0) return { start: 0, end: 0 }
  const step = normalizeSize(size)
  const i = clampChunkIndex(index, total, step)
  const start = i * step + 1
  return { start, end: Math.min(total, start + step - 1) }
}

/** The 1-based page numbers contained in a chunk, in order. */
export function pageNumbersInChunk(
  index: number,
  totalPages: number,
  size: number = PDF_PAGE_CHUNK_SIZE,
): number[] {
  const { start, end } = chunkRange(index, totalPages, size)
  if (start === 0) return []
  const numbers: number[] = []
  for (let p = start; p <= end; p++) numbers.push(p)
  return numbers
}

/** Human-readable label for the toolbar, e.g. `Seiten 26–50 von 120`. */
export function chunkLabel(
  index: number,
  totalPages: number,
  size: number = PDF_PAGE_CHUNK_SIZE,
): string {
  const total = normalizeTotal(totalPages)
  if (total === 0) return 'Keine Seiten'
  const { start, end } = chunkRange(index, total, size)
  const pages = start === end ? `Seite ${start}` : `Seiten ${start}–${end}`
  return `${pages} von ${total}`
}
