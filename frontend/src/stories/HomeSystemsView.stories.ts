import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import HomeSystemsView from '../views/HomeSystemsView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { HomeSystemListItem } from '../api/home'

/** Haus › Anlagen: a few invented systems of an invented house. */

const base: Omit<HomeSystemListItem, 'id' | 'name' | 'category'> = {
  location: null,
  manufacturer: null,
  model: null,
  archived: false,
  guideCount: 0,
  itemCount: 0,
  noteCount: 0,
  lastNoteOn: null,
  matches: [],
  updatedAt: '2026-11-20T10:00:00Z',
  groupId: 7,
  groupName: 'Familie',
  household: true,
  ownerUserId: 1,
  ownerName: 'Admin',
  canManage: true,
}

export const HOME_SYSTEMS: HomeSystemListItem[] = [
  { ...base, id: 1, name: 'Enthärtungsanlage', category: 'water', location: 'Hauswirtschaftsraum', manufacturer: 'Beispielwerk', model: 'Soft 300', guideCount: 2, noteCount: 4, lastNoteOn: '2026-11-15' },
  { ...base, id: 2, name: 'Lüftungsanlage', category: 'ventilation', location: 'Dachboden', manufacturer: 'Musterluft', model: 'KWL 250', guideCount: 1, noteCount: 1, lastNoteOn: '2026-09-02' },
  { ...base, id: 3, name: 'Perlatoren', category: 'sanitary', location: 'Alle Armaturen', itemCount: 5, guideCount: 1 },
  { ...base, id: 4, name: 'Gartenpumpe', category: 'garden', location: 'Gartenhaus', groupId: null, groupName: null, household: false },
]

const handlers = (systems: HomeSystemListItem[]) => [
  http.get('/api/home/systems', ({ request }) => {
    const q = new URL(request.url).searchParams.get('q')?.toLowerCase()
    if (!q) return HttpResponse.json({ systems })
    return HttpResponse.json({
      systems: systems
        .filter((s) => s.id === 3)
        .map((s) => ({ ...s, matches: ['Einzelteil „Küche“', 'Anleitung „Perlatoren entkalken“'] })),
    })
  }),
  http.get('/api/home/share-groups', () => HttpResponse.json({ householdId: 7, groups: [{ id: 7, name: 'Familie', household: true }] })),
  ...defaultHandlers,
]

const meta: Meta<typeof HomeSystemsView> = {
  title: 'Views/HomeSystemsView',
  component: HomeSystemsView,
  decorators: [routeFromParameters('/haus/anlagen')],
  parameters: { msw: { handlers: handlers(HOME_SYSTEMS) } },
}

export default meta
type Story = StoryObj<typeof HomeSystemsView>

export const Liste: Story = { name: 'Anlagen des Hauses' }

export const Suche: Story = {
  name: 'Suche findet ein Einzelteil',
  parameters: { route: '/haus/anlagen?q=m24' },
}

export const Telefon: Story = {
  name: 'Auf dem Telefon',
  parameters: { testViewport: { width: 390, height: 844 } },
}

export const Leer: Story = {
  name: 'Noch keine Anlage',
  parameters: { msw: { handlers: handlers([]) } },
}
