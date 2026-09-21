import type { Meta, StoryObj } from '@storybook/vue3'
import SubjectPersonsView from '../views/SubjectPersonsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { AssessmentSetting, SubjectPerson } from '../api/documents'

/**
 * The people a document can be about (issue #1281). Names, relations and
 * dates here are invented, as everything in the repo must be.
 */

const PERSONS: SubjectPerson[] = [
  {
    id: 1,
    full_name: 'Alex Beispiel',
    relation_tag: 'ich',
    relation_kind: 'self',
    birth_date: '1980-01-01',
    in_household: true,
    tax_cost_bearer: 'user',
    requires_tax_review: true,
    requires_tax_review_override: null,
    own_tax_return_from_tax_year: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    full_name: 'Kim Beispiel',
    relation_tag: 'kind',
    relation_kind: 'child',
    birth_date: '2010-05-05',
    in_household: true,
    tax_cost_bearer: 'user',
    requires_tax_review: false,
    requires_tax_review_override: false,
    own_tax_return_from_tax_year: 2028,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-02-01T00:00:00.000Z',
  },
]

const SETTINGS: AssessmentSetting[] = [
  {
    id: 1,
    assessment_type: 'zusammen',
    valid_from_tax_year: 2023,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  },
]

const personHandlers = [
  http.get('/api/documents/subject-persons', () => HttpResponse.json({ items: PERSONS })),
  http.get('/api/documents/assessment-settings', () => HttpResponse.json({ items: SETTINGS })),
  ...defaultHandlers,
]

const meta: Meta<typeof SubjectPersonsView> = {
  title: 'Views/SubjectPersonsView',
  component: SubjectPersonsView,
  decorators: [routeFromParameters('/dokumente/bezugspersonen')],
  parameters: { msw: { handlers: personHandlers } },
}

export default meta
type Story = StoryObj<typeof SubjectPersonsView>

export const MitPersonen: Story = { name: 'Mit Personen' }

export const NochNiemand: Story = {
  name: 'Noch niemand angelegt',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/subject-persons', () => HttpResponse.json({ items: [] })),
        http.get('/api/documents/assessment-settings', () => HttpResponse.json({ items: [] })),
        ...personHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/subject-persons', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...personHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
