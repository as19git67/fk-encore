/**
 * A photo book played as a slideshow (documentation/plans/fotobuch.md,
 * stage 6): the book's own order, chapters and captions, in the recap player.
 *
 * Every page becomes one slide in reading order. A chapter opener shows its
 * photo with the chapter title on top; an opener whose photo was taken out
 * hands its title to the next slide. A page of one, two or three photos is a
 * single photo, a duo or a trio; a page of four or more is split into
 * collages of two or three, so no photo is lost and none gets a tile too
 * small to see. A slide carries the first caption of its photos when the page
 * shows captions — what the printed page would say.
 */
import type { Photo } from '../api/photos'
import type { PhotoBook, PhotoBookPage } from '../api/photoBooks'

export interface PlanSlide {
  photos: Photo[]
  caption?: string | null
  chapterTitle?: string | null
  chapterSubtitle?: string | null
}

/** Largest collage the player draws. */
const MAX_SLIDE_PHOTOS = 3

/** The slot as the player needs it: an id, a file and its crop. */
function slotPhoto(slot: PhotoBookPage['slots'][number], createdAt: string): Photo {
  return {
    id: slot.photo_id,
    user_id: 0,
    filename: slot.filename,
    original_name: slot.filename,
    mime_type: '',
    size: 0,
    created_at: createdAt,
    curation_status: 'visible',
    ...(slot.auto_crop ? { auto_crop: slot.auto_crop } : {}),
  }
}

/** Sizes of at most three that add up to `n`, as even as possible: 4 → 2+2, 5 → 3+2, 7 → 3+2+2. */
export function chunkSizes(n: number): number[] {
  if (n <= 0) return []
  const count = Math.ceil(n / MAX_SLIDE_PHOTOS)
  const base = Math.floor(n / count)
  const extra = n % count
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0))
}

export function photoBookSlideshow(book: PhotoBook): PlanSlide[] {
  const chapters = new Map(book.chapters.map((c) => [c.id, c]))
  const out: PlanSlide[] = []
  let pendingChapter: { title: string; subtitle: string | null } | null = null
  const pages = [...book.pages].sort((a, b) => a.position - b.position)
  for (const page of pages) {
    const chapter = page.chapter_id != null ? chapters.get(page.chapter_id) ?? null : null
    if (page.kind === 'opener' && chapter) pendingChapter = { title: chapter.title, subtitle: chapter.subtitle }
    const slots = [...page.slots].sort((a, b) => a.slot - b.slot)
    let at = 0
    for (const size of chunkSizes(slots.length)) {
      const group = slots.slice(at, at + size)
      at += size
      const caption = page.captions ? group.find((s) => s.caption?.trim())?.caption?.trim() ?? null : null
      out.push({
        photos: group.map((s) => slotPhoto(s, book.created_at)),
        caption,
        chapterTitle: pendingChapter?.title ?? null,
        chapterSubtitle: pendingChapter?.subtitle ?? null,
      })
      pendingChapter = null
    }
  }
  return out
}
