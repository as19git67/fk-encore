import { describe, expect, it } from 'vitest'
import {
  PDF_PAGE_CHUNK_SIZE,
  chunkCount,
  chunkForPage,
  chunkLabel,
  chunkRange,
  clampChunkIndex,
  pageNumbersInChunk,
} from './pdfPageChunks'

describe('pdfPageChunks', () => {
  it('uses a chunk size of 25 pages', () => {
    expect(PDF_PAGE_CHUNK_SIZE).toBe(25)
  })

  describe('chunkCount', () => {
    it('returns 0 for empty documents', () => {
      expect(chunkCount(0)).toBe(0)
      expect(chunkCount(-3)).toBe(0)
      expect(chunkCount(Number.NaN)).toBe(0)
    })

    it('keeps short documents in a single chunk', () => {
      expect(chunkCount(1)).toBe(1)
      expect(chunkCount(25)).toBe(1)
    })

    it('rounds partial chunks up', () => {
      expect(chunkCount(26)).toBe(2)
      expect(chunkCount(50)).toBe(2)
      expect(chunkCount(51)).toBe(3)
      expect(chunkCount(120)).toBe(5)
    })
  })

  describe('chunkForPage', () => {
    it('maps pages to their 0-based chunk', () => {
      expect(chunkForPage(1)).toBe(0)
      expect(chunkForPage(25)).toBe(0)
      expect(chunkForPage(26)).toBe(1)
      expect(chunkForPage(50)).toBe(1)
      expect(chunkForPage(51)).toBe(2)
    })

    it('clamps out-of-range input to the first chunk', () => {
      expect(chunkForPage(0)).toBe(0)
      expect(chunkForPage(-5)).toBe(0)
    })
  })

  describe('clampChunkIndex', () => {
    it('keeps the index inside the document', () => {
      expect(clampChunkIndex(-1, 120)).toBe(0)
      expect(clampChunkIndex(2, 120)).toBe(2)
      expect(clampChunkIndex(99, 120)).toBe(4)
    })

    it('returns 0 for empty documents', () => {
      expect(clampChunkIndex(3, 0)).toBe(0)
    })
  })

  describe('chunkRange', () => {
    it('returns the inclusive 1-based page range', () => {
      expect(chunkRange(0, 120)).toEqual({ start: 1, end: 25 })
      expect(chunkRange(1, 120)).toEqual({ start: 26, end: 50 })
      expect(chunkRange(4, 120)).toEqual({ start: 101, end: 120 })
    })

    it('truncates the last chunk to the document length', () => {
      expect(chunkRange(1, 30)).toEqual({ start: 26, end: 30 })
    })

    it('clamps an out-of-range index', () => {
      expect(chunkRange(9, 30)).toEqual({ start: 26, end: 30 })
    })

    it('is empty for documents without pages', () => {
      expect(chunkRange(0, 0)).toEqual({ start: 0, end: 0 })
    })
  })

  describe('pageNumbersInChunk', () => {
    it('lists every page of the chunk in order', () => {
      expect(pageNumbersInChunk(0, 3)).toEqual([1, 2, 3])
      expect(pageNumbersInChunk(1, 28)).toEqual([26, 27, 28])
      expect(pageNumbersInChunk(0, 120)).toHaveLength(25)
      expect(pageNumbersInChunk(0, 120)[24]).toBe(25)
    })

    it('returns nothing for empty documents', () => {
      expect(pageNumbersInChunk(0, 0)).toEqual([])
    })
  })

  describe('chunkLabel', () => {
    it('describes the visible range', () => {
      expect(chunkLabel(0, 120)).toBe('Seiten 1–25 von 120')
      expect(chunkLabel(4, 120)).toBe('Seiten 101–120 von 120')
    })

    it('uses the singular for a one-page chunk', () => {
      expect(chunkLabel(1, 26)).toBe('Seite 26 von 26')
      expect(chunkLabel(0, 1)).toBe('Seite 1 von 1')
    })

    it('handles empty documents', () => {
      expect(chunkLabel(0, 0)).toBe('Keine Seiten')
    })
  })

  it('covers every page exactly once across all chunks', () => {
    const total = 137
    const seen: number[] = []
    for (let i = 0; i < chunkCount(total); i++) {
      seen.push(...pageNumbersInChunk(i, total))
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1))
  })
})
