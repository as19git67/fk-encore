import type { Meta, StoryObj } from '@storybook/vue3'
import MeterDetailView from '../views/MeterDetailView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const MOCK_METER_DETAIL = {
  id: 1,
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
  photoPath: null,
  createdAt: '2022-02-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  devices: [
    {
      id: 1,
      serialNumber: 'e_auto_pv_laden_tesla_ha',
      installedAt: '2022-02-01T01:00:00Z',
      removedAt: null,
      startValue: 0,
      endValue: null,
      notes: null,
      active: true,
    },
  ],
}

const MOCK_READINGS = [
  {
    id: 3,
    deviceId: 1,
    deviceSerial: 'e_auto_pv_laden_tesla_ha',
    value: 6461.69,
    takenAt: '2026-08-01T00:00:00Z',
    source: 'api',
    notes: null,
    enteredBy: 1,
    absoluteValue: 6461.69,
  },
  {
    id: 2,
    deviceId: 1,
    deviceSerial: 'e_auto_pv_laden_tesla_ha',
    value: 6330.48,
    takenAt: '2026-07-01T14:05:00Z',
    source: 'manual',
    notes: 'Ablesung nach dem Urlaub kontrolliert',
    enteredBy: 1,
    absoluteValue: 6330.48,
  },
  {
    id: 1,
    deviceId: 1,
    deviceSerial: 'e_auto_pv_laden_tesla_ha',
    value: 6100.12,
    takenAt: '2026-06-01T09:30:00Z',
    source: 'ocr',
    notes: null,
    enteredBy: 1,
    absoluteValue: 6100.12,
  },
]

const MOCK_REPORT = {
  meterId: 1,
  name: 'Strom Wärmepumpe',
  unit: 'kWh',
  decimals: 2,
  granularity: 'month' as const,
  from: null,
  to: null,
  totalConsumption: 361.57,
  buckets: [
    {
      key: '2026-06',
      label: 'Juni 2026',
      periodStart: '2026-06-01T00:00:00Z',
      periodEnd: '2026-06-30T23:59:59Z',
      startReadingAt: '2026-06-01T09:30:00Z',
      endReadingAt: '2026-07-01T14:05:00Z',
      startValue: 6100.12,
      endValue: 6330.48,
      consumption: 230.36,
      intervals: 1,
    },
    {
      key: '2026-07',
      label: 'Juli 2026',
      periodStart: '2026-07-01T00:00:00Z',
      periodEnd: '2026-07-31T23:59:59Z',
      startReadingAt: '2026-07-01T14:05:00Z',
      endReadingAt: '2026-08-01T00:00:00Z',
      startValue: 6330.48,
      endValue: 6461.69,
      consumption: 131.21,
      intervals: 1,
    },
  ],
}

const MOCK_API_KEYS = [
  {
    id: 1,
    meterId: 1,
    name: 'Home Assistant',
    createdAt: '2026-03-01T10:00:00Z',
    lastUsedAt: '2026-08-01T00:00:00Z',
    disabledAt: null,
  },
]

const meterHandlers = [
  http.get('/api/meters/:id/readings', () =>
    HttpResponse.json({ readings: MOCK_READINGS, total: MOCK_READINGS.length }),
  ),
  http.get('/api/meters/:id/report', () => HttpResponse.json(MOCK_REPORT)),
  http.get('/api/meters/:id/api-keys', () => HttpResponse.json({ keys: MOCK_API_KEYS })),
  http.get('/api/meters/:id', () => HttpResponse.json(MOCK_METER_DETAIL)),
  http.get('/api/groups', () => HttpResponse.json({ items: [] })),
  ...defaultHandlers,
]

const meta: Meta<typeof MeterDetailView> = {
  title: 'Views/MeterDetailView',
  component: MeterDetailView,
  parameters: {
    msw: { handlers: meterHandlers },
  },
}

export default meta
type Story = StoryObj<typeof MeterDetailView>

export const Detail: Story = {
  name: 'Zählerdetail',
}

/** Phone-sized viewport: tables must scroll instead of squeezing their columns. */
export const DetailMobil: Story = {
  name: 'Zählerdetail (Handy)',
  parameters: {
    testViewport: { width: 390, height: 1400 },
  },
}
