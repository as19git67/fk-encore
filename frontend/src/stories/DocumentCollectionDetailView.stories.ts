import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentCollectionDetailView from '../views/DocumentCollectionDetailView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_COLLECTIONS, MOCK_DOCUMENTS } from './mock-data'
import { routeFromParameters } from './storyRoute'
import type { DocumentCollectionDetail } from '../api/collections'

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

const detailHandlers = [
  http.get('/api/document-collections/:id', () => HttpResponse.json(DETAIL)),
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
