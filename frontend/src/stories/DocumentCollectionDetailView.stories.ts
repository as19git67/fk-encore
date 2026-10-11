import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentCollectionDetailView from '../views/DocumentCollectionDetailView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_COLLECTIONS, MOCK_DOCUMENTS } from './mock-data'
import { routeFromParameters } from './storyRoute'
import type { CollectionExport, DocumentCollectionDetail } from '../api/collections'

/**
 * One Sammelmappe with its documents (issue #1281): the order they go into
 * the PDF, which of them go in at all, and the summary — written, pending,
 * or failed.
 */

const DETAIL: DocumentCollectionDetail = {
  ...MOCK_COLLECTIONS[0]!,
  items: MOCK_DOCUMENTS.slice(0, 3).map((doc, i) => ({
    document_id: doc.id,
    position: i + 1,
    included: i !== 2,
    excluded_pages: i === 0 ? [2] : [],
    redactions: i === 1 ? [{ page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.05 }] : [],
    joined_by: (i === 2 ? 'rule' : 'user') as 'user' | 'rule',
    title: doc.title,
    original_filename: doc.original_filename,
    mime_type: doc.mime_type,
    sender: doc.sender ?? null,
    doc_date: doc.doc_date ?? null,
    category_slug: doc.category_slug ?? null,
    status: doc.status,
    pages_total: 3,
    visibility: doc.visibility,
    group_id: doc.group_id ?? null,
  })),
}

/** Saving a new order answers with the folder in that order, as the API does. */
const reorderHandler = http.put('/api/document-collections/:id/order', async ({ request }) => {
  const { document_ids } = (await request.json()) as { document_ids: number[] }
  const byId = new Map(DETAIL.items.map((item) => [item.document_id, item]))
  const items = document_ids.flatMap((id, i) => {
    const item = byId.get(id)
    return item ? [{ ...item, position: i + 1 }] : []
  })
  return HttpResponse.json({ ...DETAIL, items })
})

const NO_EXPORT: CollectionExport = {
  status: 'none',
  started_at: null,
  finished_at: null,
  error: null,
  filename: null,
  page_count: null,
  size_bytes: null,
  skipped_count: 0,
}

const BUILT_EXPORT: CollectionExport = {
  status: 'done',
  started_at: '2026-03-14T09:30:00Z',
  finished_at: '2026-03-14T09:30:12Z',
  error: null,
  filename: 'Steuer-2024.pdf',
  page_count: 9,
  size_bytes: 1_843_200,
  skipped_count: 0,
}

/** A tiny but valid PDF, so the page can fetch and offer the kept file. */
const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
)

/**
 * The background build: starting reports "running", the next status poll
 * finds it done — enough to watch the page switch from one to the other.
 */
function exportHandlers(initial: CollectionExport) {
  let state = initial
  return [
    http.post('/api/document-collections/:id/export', () => {
      state = { ...NO_EXPORT, status: 'running', started_at: new Date().toISOString() }
      return HttpResponse.json(state)
    }),
    http.get('/api/document-collections/:id/export', () => {
      if (state.status === 'running') {
        state = { ...BUILT_EXPORT, finished_at: new Date().toISOString() }
        return HttpResponse.json({ ...state, status: 'running' })
      }
      return HttpResponse.json(state)
    }),
    http.get('/api/document-collections/:id/export/pdf', () =>
      HttpResponse.arrayBuffer(PDF_BYTES.buffer as ArrayBuffer, {
        headers: { 'Content-Type': 'application/pdf', 'X-Collection-Skipped': '0' },
      }),
    ),
  ]
}

const detailHandlers = [
  ...exportHandlers(NO_EXPORT),
  http.get('/api/document-collections/:id', () => HttpResponse.json(DETAIL)),
  reorderHandler,
  // Before the defaults: their `/api/documents/:id` would answer this path
  // with a document, and the rule's correspondent picker would break.
  http.get('/api/documents/correspondents', () => HttpResponse.json({ items: [] })),
  ...defaultHandlers,
]

const meta: Meta<typeof DocumentCollectionDetailView> = {
  title: 'Views/DocumentCollectionDetailView',
  component: DocumentCollectionDetailView,
  decorators: [routeFromParameters('/dokumente/mappen/1')],
  parameters: { msw: { handlers: detailHandlers } },
}

export default meta
type Story = StoryObj<typeof DocumentCollectionDetailView>

export const MitDokumenten: Story = { name: 'Mit Dokumenten' }

export const NochLeer: Story = {
  name: 'Noch leer',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-collections/:id', () =>
          HttpResponse.json({ ...DETAIL, items: [], item_count: 0, included_count: 0 }),
        ),
        ...detailHandlers,
      ],
    },
  },
}

export const ZusammenfassungFehlgeschlagen: Story = {
  name: 'Zusammenfassung fehlgeschlagen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-collections/:id', () =>
          HttpResponse.json({
            ...DETAIL,
            summary: null,
            summary_stale: false,
            summary_error: 'Das Modell hat nicht geantwortet.',
          }),
        ),
        ...detailHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-collections/:id', async () => {
          await delay('infinite')
          return HttpResponse.json(DETAIL)
        }),
        ...detailHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-collections/:id', () =>
          HttpResponse.json({ message: 'Mappe nicht gefunden' }, { status: 404 }),
        ),
        ...detailHandlers,
      ],
    },
  },
}

export const PdfWirdErzeugt: Story = {
  name: 'PDF wird erzeugt',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-collections/:id/export', () =>
          HttpResponse.json({ ...NO_EXPORT, status: 'running', started_at: '2026-03-14T09:30:00Z' }),
        ),
        ...detailHandlers,
      ],
    },
  },
}

export const PdfVorhanden: Story = {
  name: 'PDF vorhanden',
  parameters: {
    msw: {
      handlers: [...exportHandlers(BUILT_EXPORT), ...detailHandlers],
    },
  },
}

export const PdfFehlgeschlagen: Story = {
  name: 'PDF fehlgeschlagen',
  parameters: {
    msw: {
      handlers: [
        ...exportHandlers({
          ...NO_EXPORT,
          status: 'failed',
          finished_at: '2026-03-14T09:31:00Z',
          error: 'qpdf exited 2: file is damaged',
        }),
        ...detailHandlers,
      ],
    },
  },
}
