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
 * The preview on a phone: one column, one scrollbar.
 *
 * Everything below each other — the pages of the current chunk, the
 * pagination to the next 25, then the document's attributes — inside the
 * page's own scroller, with the viewer's head pinned under the app's stack
 * while they go past.
 *
 * Two things went wrong here before. The panel had nothing to stretch to in
 * a viewport-tall grid and, since every level inside the viewer may shrink
 * to nothing, collapsed to its two borders: no preview at all. Giving it a
 * fixed height instead bought a scroll container inside a scroll container,
 * which is what this story now rules out.
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
    const wrapper = await waitFor(() => panel.querySelector<HTMLElement>('.canvas-wrapper'))
    await waitFor(() =>
      Array.from(panel.querySelectorAll('canvas')).find((c) => c.getBoundingClientRect().height > 50),
    )

    // The pages stand in the page's own scroller, so nothing inside the
    // viewer scrolls vertically on its own.
    const nested = wrapper.scrollHeight - wrapper.clientHeight
    if (nested > 4) {
      throw new Error(`the page stack scrolls inside the panel as well (${nested}px of it)`)
    }

    // And they are all there to scroll past, not clipped to a sliver.
    const stack = Array.from(panel.querySelectorAll<HTMLElement>('.page-item'))
    const stackHeight = stack.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0)
    if (stack.length < 6 || panel.getBoundingClientRect().height < stackHeight) {
      throw new Error(
        `the panel is ${Math.round(panel.getBoundingClientRect().height)}px for ` +
          `${stack.length} pages worth ${Math.round(stackHeight)}px`,
      )
    }

    // The attributes follow the pages rather than sitting beside them.
    const meta = await waitFor(() => document.querySelector<HTMLElement>('.meta-panel'))
    if (meta.getBoundingClientRect().top < panel.getBoundingClientRect().bottom) {
      throw new Error('the attributes do not follow the preview')
    }

    // The head is pinned, so the controls stay reachable while they do.
    const head = await waitFor(() => panel.querySelector<HTMLElement>('.viewer-head'))
    if (getComputedStyle(head).position !== 'sticky') {
      throw new Error(`the viewer head is ${getComputedStyle(head).position}, not sticky`)
    }

    // And it stays put when the pagination jumps: the jump moves the page's
    // scroller, which used to carry the head away with it — the controls
    // left the screen on the way to the page they were used to reach.
    const scroller = await waitFor(() => document.querySelector<HTMLElement>('.page-content'))
    const input = await waitFor(() => head.querySelector<HTMLInputElement>('.page-input'))
    input.value = '5'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 600))

    const pinned = head.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    if (pinned > 8) {
      throw new Error(`after the jump the head sits ${Math.round(pinned)}px into the scroller`)
    }
    const target = document.querySelector<HTMLElement>('[data-page-number="5"]')
    if (!target) throw new Error('the page jumped to is not in the stack')
    const gap = target.getBoundingClientRect().top - head.getBoundingClientRect().bottom
    if (gap < -1 || gap > 40) {
      throw new Error(`the page jumped to sits ${Math.round(gap)}px from the head, not just below it`)
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
