import type { Meta, StoryObj } from '@storybook/vue3'
import SystemStatusView from '../views/SystemStatusView.vue'
import { http, HttpResponse } from 'msw'
import { defaultHandlers } from './handlers'
import { withPermissions } from './storyPermissions'

const meta: Meta<typeof SystemStatusView> = {
  title: 'Views/SystemStatusView',
  component: SystemStatusView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof SystemStatusView>

export const AlleWarteschlangen: Story = {
  name: 'Alle Warteschlangen sichtbar',
}

export const NurDokumente: Story = {
  name: 'Nur das Dokumente-Modul freigeschaltet',
  decorators: [withPermissions(['documents.view', 'data.manage'])],
}

export const RoutingKachelnVeraltet: Story = {
  name: 'Routing: Kacheln älter als die neueste Region',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/trip-planner/routing/status', () => HttpResponse.json({
          reachable: true, version: '3.5.1', hasTiles: true,
          tilesBuiltAt: '2026-09-10T04:00:00.000Z', newestRegionAt: '2026-09-18T12:00:00.000Z',
          tilesBehindRegion: true,
        })),
        ...defaultHandlers,
      ],
    },
  },
}

export const RoutingNichtErreichbar: Story = {
  name: 'Routing: Dienst nicht erreichbar',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/trip-planner/routing/status', () => HttpResponse.json({
          reachable: false, version: null, hasTiles: false,
          tilesBuiltAt: null, newestRegionAt: '2026-09-18T12:00:00.000Z',
          tilesBehindRegion: false,
        })),
        ...defaultHandlers,
      ],
    },
  },
}
