import { describe, expect, it } from 'vitest'
import type { PhotoBook, PhotoBookPage, PhotoBookSlot } from '../api/photoBooks'
import { chunkSizes, photoBookSlideshow } from './photoBookSlideshow'

const rect = { x: 0, y: 0, w: 10, h: 10 }

function slot(id: number, caption: string | null = null): PhotoBookSlot {
  return { slot: id, photo_id: id, filename: `p${id}.jpg`, auto_crop: null, rect, dpi: 300, low_dpi: false, caption, caption_source: caption ? 'user' : null, caption_rect: null, caption_overlay: false }
}

function page(position: number, kind: PhotoBookPage['kind'], chapter: number, slots: PhotoBookSlot[], captions = true): PhotoBookPage {
  return { id: position, position, chapter_id: chapter, kind, layout: 'x', layout_options: [], full_bleed: false, text_rect: null, captions, captions_override: null, layout_source: 'rule', layout_reason: null, slots }
}

function book(pages: PhotoBookPage[]): PhotoBook {
  const chapter = (id: number, title: string) => ({ id, position: id, title, subtitle: id === 1 ? 'Juni' : null, starts_at: null, ends_at: null, title_source: 'rule' as const, title_suggestion: null })
  return { id: 1, title: 'Sommer', subtitle: null, format: 'a4-landscape', width_mm: 297, height_mm: 210, cover_photo_id: null, cover_filename: null, cover_auto_crop: null, settings: { bleed_mm: 3, crop_marks: true, spreads: true, paper_mm: 0.1, captions: true }, source: { kind: 'photos' }, page_count: pages.length, photo_count: 0, spine_mm: 6, low_dpi_count: 0, chapters: [chapter(1, 'Am Beispielsee'), chapter(2, 'Musterstadt')], pages, created_at: '2024-06-01T00:00:00Z', updated_at: '2024-06-01T00:00:00Z' }
}

describe('photo book slideshow', () => {
  it('splits a page into collages of at most three, evenly', () => {
    expect(chunkSizes(1)).toEqual([1])
    expect(chunkSizes(3)).toEqual([3])
    expect(chunkSizes(4)).toEqual([2, 2])
    expect(chunkSizes(5)).toEqual([3, 2])
    expect(chunkSizes(7)).toEqual([3, 2, 2])
  })

  it('plays the pages in order with chapter titles and captions', () => {
    const slides = photoBookSlideshow(book([
      page(3, 'photos', 2, [slot(5), slot(6, 'Alter Turm')], true),
      page(0, 'opener', 1, [slot(1)]),
      page(1, 'photos', 1, [slot(2, 'Am Ufer'), slot(3), slot(4), slot(7)], false),
      page(2, 'opener', 2, []),
    ]))
    expect(slides.map((s) => s.photos.map((p) => p.id))).toEqual([[1], [2, 3], [4, 7], [5, 6]])
    expect(slides[0]).toMatchObject({ chapterTitle: 'Am Beispielsee', chapterSubtitle: 'Juni' })
    // A page without captions shows none; an opener without a photo hands its title on.
    expect(slides[1]!.caption).toBeNull()
    expect(slides[2]!.chapterTitle).toBeNull()
    expect(slides[3]).toMatchObject({ chapterTitle: 'Musterstadt', caption: 'Alter Turm' })
  })
})
