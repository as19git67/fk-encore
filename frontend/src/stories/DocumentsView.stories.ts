import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentsView from '../views/DocumentsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import {
  MOCK_DOCUMENTS,
  MOCK_DOCUMENT_CATEGORIES,
  MOCK_DOCUMENT_COLLECTIONS,
} from './mock-data'

const meta: Meta<typeof DocumentsView> = {
  title: 'Views/DocumentsView',
  component: DocumentsView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof DocumentsView>

export const MitDokumenten: Story = {
  name: 'Mit Dokumenten',
}

/**
 * The split layout of issue #735: on a wide landscape screen the list keeps
 * the left column (500–600px) and the current document is previewed beside
 * it. The pinned viewport is what makes this story meaningful — the default
 * 1280px screenshot size sits just below the threshold, so every other story
 * still shows the single-column layout.
 */
export const GeteilteAnsicht: Story = {
  name: 'Geteilte Ansicht (breiter Bildschirm)',
  parameters: {
    testViewport: { width: 1600, height: 900 },
  },
}

/**
 * Sammelmappen sit above the documents as full-width rows. They are their own
 * story because they are the widest thing on the page: a row that reaches the
 * page gutter is where a focus ring drawn *around* an element runs out of
 * room (issue #1281).
 */
export const MitSammelmappen: Story = {
  name: 'Mit Sammelmappen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/document-collections', () =>
          HttpResponse.json({ items: MOCK_DOCUMENT_COLLECTIONS }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const LeereListe: Story = {
  name: 'Noch keine Dokumente',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents', () => HttpResponse.json({ items: [], total: 0 })),
        http.get('/api/document-categories', () =>
          HttpResponse.json({ items: MOCK_DOCUMENT_CATEGORIES }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const NurFehler: Story = {
  name: 'Nur fehlgeschlagene',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents', () =>
          HttpResponse.json({
            items: MOCK_DOCUMENTS.filter((d) => d.status === 'failed'),
            total: 1,
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const Suchergebnis: Story = {
  name: 'Suchergebnis (Paraphrase)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/search', () =>
          HttpResponse.json({
            items: MOCK_DOCUMENTS.filter((d) => d.category_slug === 'rechnungen'),
            mode: 'semantic',
            query: 'Energiekosten',
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>('[data-testid="list-search"]')
    if (!input) throw new Error('search input not found')
    input.focus()
    input.value = 'Energiekosten'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // The shared toolbar debounces the term by 300 ms before it searches.
    await new Promise((resolve) => setTimeout(resolve, 500))
  },
}

export const KeineTreffer: Story = {
  name: 'Suche ohne Treffer',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/search', () =>
          HttpResponse.json({ items: [], mode: 'hybrid', query: 'Unbekanntes Schlagwort' }),
        ),
        ...defaultHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>('[data-testid="list-search"]')
    if (!input) throw new Error('search input not found')
    input.focus()
    input.value = 'Unbekanntes Schlagwort'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // The shared toolbar debounces the term by 300 ms before it searches.
    await new Promise((resolve) => setTimeout(resolve, 500))
  },
}
