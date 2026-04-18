import type { Meta, StoryObj } from '@storybook/vue3'
import PersonsView from '../views/PersonsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_PERSONS, MOCK_FACES, MOCK_PHOTOS, MOCK_SERVICES_DEGRADED, MOCK_SERVER_PRESSURE_OK } from './mock-data'

const meta: Meta<typeof PersonsView> = {
  title: 'Views/PersonsView',
  component: PersonsView,
}

export default meta
type Story = StoryObj<typeof PersonsView>

export const MitPersonen: Story = {
  name: 'Mit erkannten Personen',
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export const MitPersonenDetails: Story = {
  name: 'Person mit Gesichtern (Detail geladen)',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/persons/:id', () =>
          HttpResponse.json({
            ...MOCK_PERSONS[1]!,
            faces: MOCK_FACES.map((f) => ({ ...f, photo: MOCK_PHOTOS[0]! })),
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const GesichtserkennungOffline: Story = {
  name: 'Gesichtserkennung offline',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/photos/service-health', () =>
          HttpResponse.json({
            services: MOCK_SERVICES_DEGRADED,
            serverPressure: MOCK_SERVER_PRESSURE_OK,
          }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}

export const Leer: Story = {
  name: 'Keine Personen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/persons', () =>
          HttpResponse.json({ persons: [], enableLocalFaces: false }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
