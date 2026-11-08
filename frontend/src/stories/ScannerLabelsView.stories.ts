import type { Meta, StoryObj } from '@storybook/vue3'
import ScannerLabelsView from '../views/ScannerLabelsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { routeFromParameters } from './storyRoute'
import { withPermissions } from './storyPermissions'
import type { ScannerOverview } from '../api/label'

/** Label › Scanner-Etiketten: numbered A4 sheets as PDF, a list to download them again. */

const SHEET = {
  name: 'Avery Zweckform L4731REV',
  columns: 7,
  rows: 27,
  labelsPerPage: 189,
  maxPages: 10,
}

const WITH_SHEETS: ScannerOverview = {
  nextNumber: 568,
  offsetXMm: 0,
  offsetYMm: 0.5,
  sheet: SHEET,
  sheets: [
    {
      id: 2,
      firstNumber: 190,
      lastNumber: 567,
      range: '#0190 – #0567',
      pages: 2,
      labels: 378,
      createdAt: '2026-11-08T08:15:00Z',
    },
    {
      id: 1,
      firstNumber: 1,
      lastNumber: 189,
      range: '#0001 – #0189',
      pages: 1,
      labels: 189,
      createdAt: '2026-10-02T17:40:00Z',
    },
  ],
}

const meta: Meta<typeof ScannerLabelsView> = {
  title: 'Views/ScannerLabelsView',
  component: ScannerLabelsView,
  decorators: [routeFromParameters('/label/scanner')],
  parameters: {
    msw: {
      handlers: [http.get('/api/label/scanner', () => HttpResponse.json(WITH_SHEETS)), ...defaultHandlers],
    },
  },
}

export default meta
type Story = StoryObj<typeof ScannerLabelsView>

export const MitBlaettern: Story = {
  name: 'Mit Blättern',
  decorators: [withPermissions(['module.label', 'label.view', 'label.print'])],
}

export const NurAnsehen: Story = {
  name: 'Nur ansehen (ohne label.print)',
  decorators: [withPermissions(['module.label', 'label.view'])],
}

export const Leer: Story = {
  name: 'Noch kein Blatt',
  decorators: [withPermissions(['module.label', 'label.view', 'label.print'])],
  parameters: {
    msw: {
      handlers: [
        http.get('/api/label/scanner', () =>
          HttpResponse.json({ nextNumber: 1, offsetXMm: 0, offsetYMm: 0, sheet: SHEET, sheets: [] }),
        ),
        ...defaultHandlers,
      ],
    },
  },
}
