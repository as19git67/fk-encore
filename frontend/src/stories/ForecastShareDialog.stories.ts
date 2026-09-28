import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import ForecastShareDialog from '../components/finance/forecast/ForecastShareDialog.vue'
import { defaultHandlers } from './handlers'
import type { ForecastShareCandidates, ForecastSharingState } from '../api/finance'

/** Sharing the forecast within the household. Names are invented. */

const OWNER: ForecastSharingState = {
  role: 'owner',
  ownerName: null,
  shares: [{ id: 1, userId: 2, userName: 'Kim', groupId: null, groupName: null, level: 'edit' }],
  offers: [],
  hasOwnForecast: true,
}

const CANDIDATES: ForecastShareCandidates = {
  users: [
    { id: 2, name: 'Kim' },
    { id: 3, name: 'Robin' },
  ],
  groups: [{ id: 7, name: 'Familie' }],
}

const handlers = (state: ForecastSharingState) => [
  http.get('/api/finance/forecast/sharing', () => HttpResponse.json(state)),
  http.get('/api/finance/forecast/share-candidates', () => HttpResponse.json(CANDIDATES)),
  ...defaultHandlers,
]

const meta: Meta<typeof ForecastShareDialog> = {
  title: 'Components/Finance/ForecastShareDialog',
  component: ForecastShareDialog,
  parameters: { msw: { handlers: handlers(OWNER) } },
  args: { visible: true },
}

export default meta
type Story = StoryObj<typeof ForecastShareDialog>

export const Eigentuemer: Story = { name: 'Eigene Prognose' }

export const Geteilt: Story = {
  name: 'Mit mir geteilt',
  parameters: { msw: { handlers: handlers({ role: 'edit', ownerName: 'Alex', shares: [], offers: [], hasOwnForecast: false }) } },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
