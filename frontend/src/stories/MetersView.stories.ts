import type { Meta, StoryObj } from '@storybook/vue3'
import MetersView from '../views/MetersView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const MOCK_METERS = [
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
    activeDeviceSerial: 'NEW-7',
    lastReadingValue: 45,
    lastReadingAt: '2026-01-01T08:00:00Z',
    absoluteTotal: 674,
  },
  {
    id: 2,
    name: 'Strom Wärmepumpe',
    type: 'electricity',
    unit: 'kWh',
    location: 'Hauswirtschaftsraum',
    notes: null,
    decimals: 1,
    groupId: null,
    ownerUserId: 1,
    activeDeviceSerial: 'E-100',
    lastReadingValue: 12345.6,
    lastReadingAt: '2026-02-15T09:30:00Z',
    absoluteTotal: 12345.6,
  },
]

const MOCK_METER_DETAIL = {
  ...MOCK_METERS[0],
  photoPath: null,
  createdAt: '2020-02-10T00:00:00Z',
  updatedAt: '2025-03-21T00:00:00Z',
  devices: [
    {
      id: 2,
      serialNumber: 'NEW-7',
      installedAt: '2025-03-21T00:00:00Z',
      removedAt: null,
      startValue: 3,
      endValue: null,
      notes: null,
      active: true,
    },
    {
      id: 1,
      serialNumber: 'OLD-1',
      installedAt: '2020-02-10T00:00:00Z',
      removedAt: '2025-03-21T00:00:00Z',
      startValue: 102,
      endValue: 734,
      notes: null,
      active: false,
    },
  ],
}

const MOCK_READINGS = [
  { id: 2, deviceId: 2, deviceSerial: 'NEW-7', value: 45, takenAt: '2026-01-01T08:00:00Z', source: 'manual', notes: null, enteredBy: 1, absoluteValue: 674 },
  { id: 1, deviceId: 1, deviceSerial: 'OLD-1', value: 500, takenAt: '2023-01-01T08:00:00Z', source: 'manual', notes: null, enteredBy: 1, absoluteValue: 398 },
]

const meterHandlers = [
  http.get('/api/meters', () => HttpResponse.json({ meters: MOCK_METERS })),
  http.get('/api/meters/:id/readings', () =>
    HttpResponse.json({ readings: MOCK_READINGS, total: MOCK_READINGS.length }),
  ),
  http.get('/api/meters/:id', () => HttpResponse.json(MOCK_METER_DETAIL)),
  http.get('/api/groups', () => HttpResponse.json({ items: [] })),
  ...defaultHandlers,
]

const meta: Meta<typeof MetersView> = {
  title: 'Views/MetersView',
  component: MetersView,
  parameters: {
    msw: { handlers: meterHandlers },
  },
}

export default meta
type Story = StoryObj<typeof MetersView>

export const Uebersicht: Story = {
  name: 'Zählerübersicht',
}

/** Opens the "Neuer Zähler" dialog so the responsive two-column form is visible. */
function openCreateDialog(canvasElement: HTMLElement) {
  const btn = Array.from(canvasElement.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Neuer Zähler'),
  )
  btn?.click()
}

export const NeuerZaehlerDialog: Story = {
  name: 'Dialog „Neuer Zähler"',
  play: async ({ canvasElement }) => {
    openCreateDialog(canvasElement)
    await new Promise((r) => setTimeout(r, 50))
  },
}

export const AblesungDialog: Story = {
  name: 'Dialog „Neue Ablesung"',
  play: async ({ canvasElement }) => {
    // Open a meter's detail panel, then the reading-entry dialog.
    canvasElement.querySelector<HTMLElement>('.meter-card')?.click()
    await new Promise((r) => setTimeout(r, 300))
    const btn = Array.from(canvasElement.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Neue Ablesung'),
    )
    btn?.click()
    await new Promise((r) => setTimeout(r, 100))
  },
}
