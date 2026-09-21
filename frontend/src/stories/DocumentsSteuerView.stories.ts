import type { Meta, StoryObj } from '@storybook/vue3'
import DocumentsSteuerView from '../views/DocumentsSteuerView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_DOCUMENTS } from './mock-data'
import { routeFromParameters } from './storyRoute'
import type { ListTaxDocumentsResponse } from '../api/documents'

/**
 * The Steuerakte (issue #1281): documents sorted into the sections of a tax
 * return. A year with nothing in it is what the page shows right after the
 * module is switched on, before a single document has been classified.
 */

const TAX: ListTaxDocumentsResponse = {
  year: 2024,
  total_documents: 3,
  sections: [
    {
      slug: 'handwerkerleistungen',
      name: 'Handwerkerleistungen',
      group: 'abzuege',
      documents: [
        { document: MOCK_DOCUMENTS[0]!, confidence: 0.91, source: 'ai' },
        { document: MOCK_DOCUMENTS[1]!, confidence: null, source: 'user' },
      ],
    },
    {
      slug: 'werbungskosten',
      name: 'Werbungskosten',
      group: 'abzuege',
      documents: [{ document: MOCK_DOCUMENTS[2]!, confidence: 0.44, source: 'ai' }],
    },
  ],
}

const taxHandlers = [
  http.get('/api/documents/tax/years', () =>
    HttpResponse.json({ years: [{ year: 2024, count: 3 }, { year: 2023, count: 8 }] }),
  ),
  http.get('/api/documents/tax', () => HttpResponse.json(TAX)),
  ...defaultHandlers,
]

const meta: Meta<typeof DocumentsSteuerView> = {
  title: 'Views/DocumentsSteuerView',
  component: DocumentsSteuerView,
  decorators: [routeFromParameters('/dokumente/steuer')],
  parameters: { msw: { handlers: taxHandlers } },
}

export default meta
type Story = StoryObj<typeof DocumentsSteuerView>

export const MitBelegen: Story = { name: 'Mit Belegen' }

export const NochNichtsZugeordnet: Story = {
  name: 'Noch nichts zugeordnet',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/tax/years', () => HttpResponse.json({ years: [] })),
        http.get('/api/documents/tax', () =>
          HttpResponse.json({ year: null, total_documents: 0, sections: [] }),
        ),
        ...taxHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/tax', async () => {
          await delay('infinite')
          return HttpResponse.json(TAX)
        }),
        ...taxHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
