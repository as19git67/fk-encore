import type { Meta, StoryObj } from '@storybook/vue3'
import MeterQuickEntryView from '../views/MeterQuickEntryView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const QUICK_ENTRY_ITEMS = [
  {
    id: 1,
    name: 'Wasser Haupt',
    type: 'water',
    unit: 'm³',
    location: 'Keller',
    notes: null,
    decimals: 0,
    groupId: null,
    ownerUserId: 1,
    activeDeviceSerial: 'W-1',
    lastReadingValue: 674,
    lastReadingAt: '2026-07-01T08:00:00Z',
    absoluteTotal: 674,
    sortOrder: 0,
  },
  {
    id: 2,
    name: 'Strom Wärmepumpe',
    type: 'electricity',
    unit: 'kWh',
    location: 'Hauswirtschaftsraum',
    notes: null,
    decimals: 2,
    groupId: null,
    ownerUserId: 1,
    activeDeviceSerial: 'e_auto_pv_laden_tesla_ha',
    lastReadingValue: 6461.69,
    lastReadingAt: '2026-08-01T00:00:00Z',
    absoluteTotal: 6461.69,
    sortOrder: 1,
  },
]

const quickEntryHandlers = [
  http.get('/api/meters/quick-entry', () =>
    HttpResponse.json({ items: QUICK_ENTRY_ITEMS, availableMeters: QUICK_ENTRY_ITEMS }),
  ),
  http.post('/api/meters/:id/readings', () => HttpResponse.json({ id: 99 })),
  ...defaultHandlers,
]

const meta: Meta<typeof MeterQuickEntryView> = {
  title: 'Views/MeterQuickEntryView',
  component: MeterQuickEntryView,
  parameters: {
    msw: { handlers: quickEntryHandlers },
  },
}

export default meta
type Story = StoryObj<typeof MeterQuickEntryView>

export const Schnellerfassung: Story = {
  name: 'Schnellerfassung',
}

/** Tablet-ish width: the save button keeps its label inside the button. */
export const SchnellerfassungSchmal: Story = {
  name: 'Schnellerfassung (schmal)',
  parameters: {
    testViewport: { width: 820, height: 900 },
  },
}

/** Phone viewport. */
export const SchnellerfassungMobil: Story = {
  name: 'Schnellerfassung (Handy)',
  parameters: {
    testViewport: { width: 390, height: 844 },
  },
}
