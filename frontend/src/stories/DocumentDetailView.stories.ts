import type { Meta, StoryObj } from '@storybook/vue3'
import { h, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DocumentDetailView from '../views/DocumentDetailView.vue'
import { useAuthStore } from '../stores/auth'
import { defaultHandlers } from './handlers'
import { buildMultiPagePdf } from './multiPagePdf'
import { http, HttpResponse } from 'msw'
import {
  MOCK_DOCUMENT_DETAIL,
  MOCK_DOCUMENT_DETAIL_CLASSIFYING,
  MOCK_DOCUMENT_DETAIL_FAILED,
  MOCK_DOCUMENT_CATEGORIES,
  MOCK_USER,
} from './mock-data'

const meta: Meta<typeof DocumentDetailView> = {
  title: 'Views/DocumentDetailView',
  component: DocumentDetailView,
  decorators: [
    (story) => ({
      components: { Story: story() },
      setup() {
        const router = useRouter()
        const target = '/dokumente/1'
        if (router.currentRoute.value.fullPath !== target) {
          router.push(target).catch(() => {})
        }
        return () => h('Story')
      },
    }),
  ],
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof DocumentDetailView>

export const FertigKlassifiziert: Story = {
  name: 'Fertig klassifiziert',
}

export const InKiAnalyse: Story = {
  name: 'In KI-Analyse',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/:id', () => HttpResponse.json(MOCK_DOCUMENT_DETAIL_CLASSIFYING)),
        http.get('/api/document-categories', () =>
          HttpResponse.json({ items: MOCK_DOCUMENT_CATEGORIES }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const Fehlgeschlagen: Story = {
  name: 'Klassifikation fehlgeschlagen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/:id', () => HttpResponse.json(MOCK_DOCUMENT_DETAIL_FAILED)),
        http.get('/api/document-categories', () =>
          HttpResponse.json({ items: MOCK_DOCUMENT_CATEGORIES }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const PdfNichtVerfuegbar: Story = {
  name: 'PDF kann nicht geladen werden',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/:id/file', () =>
          HttpResponse.text('Not found', { status: 404 }),
        ),
        http.get('/api/documents/:id', () => HttpResponse.json(MOCK_DOCUMENT_DETAIL)),
        ...defaultHandlers,
      ],
    },
  },
}

/**
 * 30 pages: enough to scroll page after page *and* to cross the 25-page
 * chunk boundary, so the "Seiten 26–30 von 30" pagination shows up (#919).
 */
export const MehrseitigesDokument: Story = {
  name: 'Mehrseitiges Dokument (30 Seiten)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/:id/file', () =>
          new HttpResponse(buildMultiPagePdf(30), {
            headers: { 'Content-Type': 'application/pdf' },
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const NurLesend: Story = {
  name: 'Nur lesender Betrachter',
  decorators: [
    (story) => ({
      components: { Story: story() },
      setup() {
        const auth = useAuthStore()
        onMounted(() => {
          auth.user = { ...MOCK_USER, permissions: ['documents.view'] }
        })
        return () => h('Story')
      },
    }),
  ],
}
