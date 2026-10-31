import type { Meta, StoryObj } from '@storybook/vue3'
import SystemStatusView from '../views/SystemStatusView.vue'
import { http, HttpResponse } from 'msw'
import { defaultHandlers } from './handlers'
import { withPermissions } from './storyPermissions'
import type { DemoStatus } from '../api/demo'

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
          reachable: true, reason: null, version: '3.5.1', hasTiles: true,
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
          reachable: false, reason: 'fetch failed: getaddrinfo ENOTFOUND routing', version: null, hasTiles: false,
          tilesBuiltAt: null, newestRegionAt: '2026-09-18T12:00:00.000Z',
          tilesBehindRegion: false,
        })),
        ...defaultHandlers,
      ],
    },
  },
}

const NO_CONTENT = { users: 0, photos: 0, documents: 0, transactions: 0, depot_transactions: 0, meter_readings: 0, trip_plans: 0 }

function demoStatus(body: DemoStatus) {
  return [http.get('/api/admin/demo/status', () => HttpResponse.json(body)), ...defaultHandlers]
}

export const DemodatenLaden: Story = {
  name: 'Demodaten: im System mit Daten nicht verfügbar',
  parameters: {
    msw: { handlers: demoStatus({ untouched: false, counts: { ...NO_CONTENT, users: 2, transactions: 312 }, run: null }) },
  },
}

export const DemodatenLaufen: Story = {
  name: 'Demodaten: werden geladen',
  parameters: {
    msw: {
      handlers: demoStatus({
        untouched: false,
        counts: NO_CONTENT,
        run: {
          id: 1, status: 'running', stage: 'bookings', size: 'full',
          progress: { bookings: { done: 150, total: 500 } }, summary: null, error: null,
          started_at: '2026-10-31T09:00:00.000Z', finished_at: null,
        },
      }),
    },
  },
}

export const DemodatenGeladen: Story = {
  name: 'Demodaten: geladen',
  parameters: {
    msw: {
      handlers: demoStatus({
        untouched: true,
        counts: NO_CONTENT,
        run: {
          id: 1, status: 'done', stage: null, size: 'full',
          progress: { bookings: { done: 500, total: 500 } }, summary: { users: 1, accounts: 4, bookings: 500 }, error: null,
          started_at: '2026-10-31T09:00:00.000Z', finished_at: '2026-10-31T09:00:12.000Z',
        },
      }),
    },
  },
}
