import type { Meta, StoryObj } from '@storybook/vue3'
import LabelView from '../views/LabelView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { LabelTemplate } from '../api/label'

/**
 * Printing a label (issue #1281). Everything here depends on a CUPS server
 * that may not be there, so "no printer" and "CUPS says no" are states the
 * page must survive, not error screens.
 */

const TEMPLATES: LabelTemplate[] = [
  {
    id: 'ordner',
    name: 'Ordnerrücken',
    text: 'Versicherungen 2025',
    labelCode: '62',
    fontKey: 'large',
    align: 'center',
    bold: true,
  },
  {
    id: 'kiste',
    name: 'Kistenaufkleber',
    text: 'Keller · Werkzeug',
    labelCode: '29',
    fontKey: 'medium',
    align: 'left',
    bold: false,
  },
]

const labelHandlers = [
  http.get('/api/label/printers', () =>
    HttpResponse.json({
      printers: [
        {
          name: 'QL-800',
          info: 'Etikettendrucker Büro',
          location: 'Arbeitszimmer',
          state: 3,
          stateLabel: 'bereit',
          makeAndModel: 'Beispiel QL-800',
        },
      ],
      selected: 'QL-800',
      cupsError: null,
    }),
  ),
  http.get('/api/label/templates', () =>
    HttpResponse.json({ templates: TEMPLATES, lastTemplateId: 'ordner' }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof LabelView> = {
  title: 'Views/LabelView',
  component: LabelView,
  decorators: [routeFromParameters('/label')],
  parameters: { msw: { handlers: labelHandlers } },
}

export default meta
type Story = StoryObj<typeof LabelView>

export const MitDrucker: Story = { name: 'Mit Drucker' }

export const OhneDrucker: Story = {
  name: 'Kein Drucker gefunden',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/label/printers', () =>
          HttpResponse.json({ printers: [], selected: null, cupsError: null }),
        ),
        ...labelHandlers,
      ],
    },
  },
}

export const CupsNichtErreichbar: Story = {
  name: 'CUPS nicht erreichbar',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/label/printers', () =>
          HttpResponse.json({
            printers: [],
            selected: null,
            cupsError: 'Verbindung abgelehnt',
          }),
        ),
        ...labelHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/label/printers', async () => {
          await delay('infinite')
          return HttpResponse.json({ printers: [], selected: null, cupsError: null })
        }),
        ...labelHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
