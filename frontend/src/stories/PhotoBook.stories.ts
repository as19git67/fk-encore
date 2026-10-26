import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import { useRouter } from 'vue-router'
import { http, HttpResponse } from 'msw'
import PhotoBookDetailView from '../views/PhotoBookDetailView.vue'
import PhotoBooksView from '../views/PhotoBooksView.vue'
import { defaultHandlers } from './handlers'
import type { PageRect, PhotoBook, PhotoBookPage, PhotoBookSlot } from '../api/photoBooks'

/**
 * A photo book of synthetic photos (documentation/plans/fotobuch.md). The
 * cells are what the server sends for A4 landscape: shares of the page.
 */
const FILES = ['castle.jpg', 'fish.jpg', 'museum.jpg', 'seagull.jpg', 'steak.jpg']
let nextPhoto = 1

function slot(i: number, rect: PageRect, lowDpi = false): PhotoBookSlot {
  const id = nextPhoto++
  return {
    slot: i,
    photo_id: id,
    filename: FILES[id % FILES.length]!,
    auto_crop: null,
    rect,
    dpi: lowDpi ? 140 : 320,
    low_dpi: lowDpi,
    caption: null,
    caption_source: null,
    caption_rect: null,
    caption_overlay: false,
    caption_repeated: false,
  }
}

/** A framed slot with a caption strip of 7 mm under it, as the server cuts it. */
function captioned(s: PhotoBookSlot, text: string): PhotoBookSlot {
  const strip = 7 / 210
  return {
    ...s,
    rect: { ...s.rect, h: s.rect.h - strip },
    caption: text,
    caption_source: 'llm',
    caption_rect: { x: s.rect.x, y: s.rect.y + s.rect.h - strip + 1.2 / 210, w: s.rect.w, h: strip - 1.2 / 210 },
  }
}

const M = { x: 12 / 297, y: 12 / 210 }
const CW = 1 - 2 * M.x
const CH = 1 - 2 * M.y

function page(id: number, chapter: number, kind: PhotoBookPage['kind'], layout: string, options: [string, string][], rects: PageRect[], extra: Partial<PhotoBookPage> = {}): PhotoBookPage {
  return {
    id,
    position: id - 1,
    chapter_id: chapter,
    kind,
    layout,
    layout_options: options.map(([oid, name]) => ({ id: oid, name })),
    full_bleed: false,
    text_rect: null,
    captions: false,
    captions_override: null,
    layout_source: 'rule',
    layout_reason: null,
    slots: rects.map((r, i) => slot(i, r, id === 3 && i === 2)),
    ...extra,
  }
}

const opener = (id: number, chapter: number) => page(id, chapter, 'opener', 'opener', [['opener', 'Kapitelanfang']],
  [{ x: M.x, y: M.y + CH * 0.22, w: CW, h: CH * 0.78 }],
  { text_rect: { x: M.x, y: M.y, w: CW, h: CH * 0.2 } })

const THREE: [string, string][] = [['cols', 'Spalten'], ['hero-left', 'Groß links'], ['hero-top', 'Groß oben']]
const TWO: [string, string][] = [['side', 'Nebeneinander'], ['stack', 'Übereinander'], ['big-small', 'Groß + Klein']]

const MOCK_BOOK: PhotoBook = {
  id: 1,
  title: 'Sommer am See',
  subtitle: 'Juni 2024',
  format: 'a4-landscape',
  width_mm: 297,
  height_mm: 210,
  cover_photo_id: 1,
  cover_filename: 'castle.jpg',
  cover_auto_crop: null,
  settings: { bleed_mm: 3, crop_marks: false, spreads: true, paper_mm: 0.12, captions: false },
  source: { kind: 'photos', photo_ids: [1, 2, 3, 4, 5, 6, 7, 8], quality_min: null, aesthetic_min: null, without_recognisable_faces: false, max_photos: null },
  page_count: 5,
  photo_count: 9,
  spine_mm: 0.4,
  low_dpi_count: 1,
  chapters: [
    { id: 1, position: 0, title: 'Rund um den Alten Turm', subtitle: 'Samstag, 1. Juni 2024', starts_at: '2024-06-01 09:00:00', ends_at: '2024-06-01 18:00:00', title_source: 'llm', title_suggestion: 'Rund um den Alten Turm' },
    { id: 2, position: 1, title: 'Tag 2', subtitle: 'Sonntag, 2. Juni 2024', starts_at: '2024-06-02 09:00:00', ends_at: '2024-06-02 18:00:00', title_source: 'user', title_suggestion: 'Ein Tag am Beispielsee' },
  ],
  pages: [
    opener(1, 1),
    page(2, 1, 'photos', 'full', [['full', 'Randlos'], ['single', 'Mit Rand']], [{ x: 0, y: 0, w: 1, h: 1 }], { full_bleed: true }),
    page(3, 1, 'photos', 'hero-left', THREE, [
      { x: M.x, y: M.y, w: CW * 0.6 - 0.007, h: CH },
      { x: M.x + CW * 0.6 + 0.007, y: M.y, w: CW * 0.4 - 0.007, h: CH / 2 - 0.01 },
      { x: M.x + CW * 0.6 + 0.007, y: M.y + CH / 2 + 0.01, w: CW * 0.4 - 0.007, h: CH / 2 - 0.01 },
    ], { layout_source: 'llm', layout_reason: 'Das stärkste Foto steht groß, die beiden anderen ruhig daneben.' }),
    opener(4, 2),
    (() => {
      const p = page(5, 2, 'photos', 'side', TWO, [
        { x: M.x, y: M.y, w: CW / 2 - 0.007, h: CH },
        { x: M.x + CW / 2 + 0.007, y: M.y, w: CW / 2 - 0.007, h: CH },
      ], { captions: true, captions_override: true })
      p.slots = [captioned(p.slots[0]!, 'Morgens am Steg des Beispielsees'), captioned(p.slots[1]!, 'Möwen über der Uferpromenade von Musterstadt')]
      return p
    })(),
  ],
  created_at: '2024-07-01T10:00:00Z',
  updated_at: '2024-07-02T10:00:00Z',
}

const handlers = [
  http.get('/api/photo-books', () => HttpResponse.json({
    books: [
      { id: 1, title: 'Sommer am See', subtitle: 'Juni 2024', format: 'a4-landscape', page_count: 5, photo_count: 9, cover_filename: 'castle.jpg', updated_at: '2024-07-02T10:00:00Z' },
      { id: 2, title: 'Winter', subtitle: null, format: 'square-21', page_count: 24, photo_count: 61, cover_filename: 'seagull.jpg', updated_at: '2024-02-10T10:00:00Z' },
    ],
    formats: [],
  })),
  http.get('/api/photo-books/:id/export', () => HttpResponse.json({ status: 'none', progress: 0, files: [] })),
  http.get('/api/photo-books/:id/ai', () => HttpResponse.json({ status: 'none', job: null })),
  http.get('/api/photo-books-layout-stats', () => HttpResponse.json({ rule: { pages: 12, changed: 3 }, llm: { pages: 4, changed: 0 }, llm_differs: 2 })),
  http.get('/api/photo-books/:id', () => HttpResponse.json(MOCK_BOOK)),
  ...defaultHandlers,
]

function at(path: string) {
  return (story: () => unknown) => ({
    setup() {
      const StoryComponent = story()
      const router = useRouter()
      if (router.currentRoute.value.path !== path) router.push(path).catch(() => {})
      return () => h(StoryComponent as any)
    },
  })
}

const meta: Meta = {
  title: 'Views/PhotoBook',
  parameters: { msw: { handlers } },
}

export default meta

export const Liste: StoryObj<typeof PhotoBooksView> = {
  name: 'Fotobücher (Liste)',
  render: () => ({ components: { PhotoBooksView }, template: '<PhotoBooksView />' }),
  decorators: [at('/fotos/fotobuecher')],
}

export const Buch: StoryObj<typeof PhotoBookDetailView> = {
  name: 'Fotobuch (Seiten)',
  render: () => ({ components: { PhotoBookDetailView }, template: '<PhotoBookDetailView />' }),
  decorators: [at('/fotos/fotobuecher/1')],
}
