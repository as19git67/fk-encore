import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentsView from '../views/DocumentsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_DOCUMENTS, MOCK_DOCUMENT_CATEGORIES } from './mock-data'

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
    const input = canvasElement.querySelector<HTMLInputElement>('input.search-input')
    if (input) {
      input.focus()
      input.value = 'Energiekosten'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
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
    const input = canvasElement.querySelector<HTMLInputElement>('input.search-input')
    if (input) {
      input.focus()
      input.value = 'Unbekanntes Schlagwort'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  },
}
