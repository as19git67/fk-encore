import type { Meta, StoryObj } from '@storybook/vue3'
import MeterQuickEntryConfigView from '../views/MeterQuickEntryConfigView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_METERS } from './mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * Which meters the quick entry asks for, and in what order (issue #1281).
 * Nothing configured yet is how the page starts out for a new household.
 */

const configHandlers = [
  http.get('/api/meters/quick-entry', () =>
    HttpResponse.json({
      items: MOCK_METERS.map((m, i) => ({ ...m, sortOrder: i + 1 })),
      availableMeters: MOCK_METERS,
    }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof MeterQuickEntryConfigView> = {
  title: 'Views/MeterQuickEntryConfigView',
  component: MeterQuickEntryConfigView,
  decorators: [routeFromParameters('/zaehler/schnellerfassung/konfiguration')],
  parameters: { msw: { handlers: configHandlers } },
}

export default meta
type Story = StoryObj<typeof MeterQuickEntryConfigView>

export const MitAuswahl: Story = { name: 'Mit Auswahl' }

export const NochNichtsGewaehlt: Story = {
  name: 'Noch nichts gewählt',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/meters/quick-entry', () =>
          HttpResponse.json({ items: [], availableMeters: MOCK_METERS }),
        ),
        ...configHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/meters/quick-entry', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [], availableMeters: [] })
        }),
        ...configHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
