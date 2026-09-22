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
      setup() {
        const StoryComponent = story()
        const router = useRouter()
        const target = '/dokumente/1'
        if (router.currentRoute.value.fullPath !== target) {
          router.push(target).catch(() => {})
        }
        return () => h(StoryComponent)
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
      setup() {
        const StoryComponent = story()
        const auth = useAuthStore()
        onMounted(() => {
          auth.user = { ...MOCK_USER, permissions: ['documents.view'] }
        })
        return () => h(StoryComponent)
      },
    }),
  ],
}

/**
 * The preview on a phone (issue: "bei den Dokumenten wird auf dem Handy keine
 * PDF-Vorschau angezeigt").
 *
 * One column, and the page no longer scrolls as a whole, so the panel is a
 * grid item in a box that is already viewport-tall. Everything inside the
 * viewer may shrink to nothing — that is what lets the page stack scroll
 * rather than the document — so with nothing asking for height the panel
 * collapsed to its two borders and clipped the rendered pages away.
 *
 * The play function measures what a reader actually sees: how much of the
 * first page lies inside the panel.
 */
export const Telefonbreite: Story = {
  name: 'Telefonbreite (PDF-Vorschau)',
  parameters: {
    testViewport: { width: 360, height: 740 },
    msw: {
      handlers: [
        http.get('/api/documents/:id/file', () =>
          new HttpResponse(buildMultiPagePdf(6), {
            headers: { 'Content-Type': 'application/pdf' },
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
  play: async () => {
    const panel = await waitFor(() => document.querySelector<HTMLElement>('.pdf-panel'))
    const canvas = await waitFor(() =>
      Array.from(panel.querySelectorAll('canvas')).find((c) => c.getBoundingClientRect().height > 50),
    )
    const page = canvas.getBoundingClientRect()
    const box = panel.getBoundingClientRect()
    const shown = Math.max(0, Math.min(page.bottom, box.bottom) - Math.max(page.top, box.top))
    if (shown < 200) {
      throw new Error(
        `only ${Math.round(shown)}px of the first page are inside the preview ` +
          `(panel ${Math.round(box.height)}px, page ${Math.round(page.height)}px)`,
      )
    }
  },
}

async function waitFor<T>(read: () => T | null | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the PDF to render')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
