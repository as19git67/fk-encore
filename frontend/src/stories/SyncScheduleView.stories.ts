import type { Meta, StoryObj } from '@storybook/vue3'
import SyncScheduleView from '../views/finance/SyncScheduleView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_BANKCONTACTS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * When a bank contact fetches on its own (issue #1281). A contact that has
 * never been given a time is the state a new contact starts in.
 */

const scheduleHandlers = [
  http.get('/api/finance/bankcontacts', () => HttpResponse.json({ items: MOCK_BANKCONTACTS })),
  http.get('/api/finance/bankcontacts/:id/schedule', () =>
    HttpResponse.json({
      bankcontact_id: 1,
      slots: [
        { weekdays: [1, 2, 3, 4, 5], time: '07:30', tz: 'Europe/Berlin' },
        { weekdays: [6], time: '10:00', tz: 'Europe/Berlin' },
      ],
    }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof SyncScheduleView> = {
  title: 'Views/SyncScheduleView',
  component: SyncScheduleView,
  decorators: [routeFromParameters('/finanzen/bankkontakte/1/zeiten')],
  parameters: { msw: { handlers: scheduleHandlers } },
}

export default meta
type Story = StoryObj<typeof SyncScheduleView>

export const MitZeiten: Story = { name: 'Mit Abrufzeiten' }

export const NochKeineZeit: Story = {
  name: 'Noch keine Abrufzeit',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/bankcontacts/:id/schedule', () =>
          HttpResponse.json({ bankcontact_id: 1, slots: [] }),
        ),
        ...scheduleHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
