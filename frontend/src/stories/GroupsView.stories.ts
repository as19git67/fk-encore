import type { Meta, StoryObj } from '@storybook/vue3'
import GroupsView from '../views/GroupsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'

/**
 * Households (issue #1281): who shares documents with whom. Being in none
 * is the normal state for a single user, and the page has to explain that
 * rather than show an empty table.
 */

const GROUPS = [
  { id: 1, slug: 'haushalt', name: 'Haushalt', my_role: 'owner' as const, member_count: 3 },
  { id: 2, slug: 'verein', name: 'Verein', my_role: 'member' as const, member_count: 8 },
]

const groupHandlers = [
  http.get('/api/groups', () => HttpResponse.json({ items: GROUPS })),
  ...defaultHandlers,
]

const meta: Meta<typeof GroupsView> = {
  title: 'Views/GroupsView',
  component: GroupsView,
  decorators: [routeFromParameters('/dokumente/gruppen')],
  parameters: { msw: { handlers: groupHandlers } },
}

export default meta
type Story = StoryObj<typeof GroupsView>

export const MitGruppen: Story = { name: 'Mit Gruppen' }

export const KeineGruppe: Story = {
  name: 'Noch keine Gruppe',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/groups', () => HttpResponse.json({ items: [] })),
        ...groupHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/groups', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...groupHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
