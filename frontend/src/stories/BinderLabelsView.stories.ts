import type { Meta, StoryObj } from '@storybook/vue3'
import BinderLabelsView from '../views/BinderLabelsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { routeFromParameters } from './storyRoute'
import { withPermissions } from './storyPermissions'
import type { BinderPage, BinderPageSummary } from '../api/label'

/** Label › Ordneretiketten: four spine labels per A4 sheet, saved under a name. */

const PAGE: BinderPage = {
  id: 3,
  name: 'Arbeitszimmer',
  labels: [
    '# Steuer\n## 2025\nBelege und Bescheide',
    '## Versicherungen\n**Haus** und *Auto*\n\n---\n- Hausrat\n- Kfz',
    '',
    '# Versicherungsunterlagen\n\n\nStrom und Gas\nZählerstände ab 2020',
  ],
  direction: 'across',
  align: 'center',
  createdAt: '2026-11-20T08:00:00Z',
  updatedAt: '2026-11-21T18:30:00Z',
}

const PAGES: BinderPageSummary[] = [
  { id: 3, name: 'Arbeitszimmer', excerpt: 'Steuer', updatedAt: '2026-11-21T18:30:00Z' },
  { id: 4, name: 'Keller', excerpt: 'Werkzeug', updatedAt: '2026-11-02T10:00:00Z' },
]

const handlers = [
  http.get('/api/label/binder/pages', () => HttpResponse.json({ pages: PAGES })),
  http.get('/api/label/binder/pages/:id', () => HttpResponse.json(PAGE)),
  ...defaultHandlers,
]

const meta: Meta<typeof BinderLabelsView> = {
  title: 'Views/BinderLabelsView',
  component: BinderLabelsView,
  decorators: [routeFromParameters('/label/ordner')],
  parameters: { msw: { handlers } },
}

export default meta
type Story = StoryObj<typeof BinderLabelsView>

export const GespeicherteSeite: Story = {
  name: 'Gespeicherte Seite, quer',
  decorators: [withPermissions(['module.label', 'label.view', 'label.print'])],
  parameters: { route: '/label/ordner?seite=3' },
}

export const Laengs: Story = {
  name: 'Längs, links ausgerichtet',
  decorators: [withPermissions(['module.label', 'label.view', 'label.print'])],
  parameters: {
    route: '/label/ordner?seite=3',
    msw: {
      handlers: [
        http.get('/api/label/binder/pages', () => HttpResponse.json({ pages: PAGES })),
        http.get('/api/label/binder/pages/:id', () => HttpResponse.json({ ...PAGE, direction: 'along', align: 'left' })),
        ...defaultHandlers,
      ],
    },
  },
}

export const NeueSeite: Story = {
  name: 'Neue Seite (ohne label.print)',
  decorators: [withPermissions(['module.label', 'label.view'])],
  parameters: {
    msw: {
      handlers: [http.get('/api/label/binder/pages', () => HttpResponse.json({ pages: [] })), ...defaultHandlers],
    },
  },
}
