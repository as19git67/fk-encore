import type { Meta, StoryObj } from '@storybook/vue3'
import TaxSectionHintsView from '../views/TaxSectionHintsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { TaxHintEntry } from '../api/documents'

/**
 * What each tax section tells the classifier (issue #1281). A section whose
 * hint was overwritten by hand has to be visibly different from one still on
 * its default.
 */

const HINTS: TaxHintEntry[] = [
  {
    slug: 'handwerkerleistungen',
    name: 'Handwerkerleistungen',
    group: 'abzuege',
    default_hint: 'Rechnungen für Arbeiten am Wohnraum.',
    effective_hint: 'Nur der Arbeitslohn zählt; Material bleibt außen vor.',
    is_overridden: true,
    updated_at: '2025-05-12T08:00:00.000Z',
  },
  {
    slug: 'werbungskosten',
    name: 'Werbungskosten',
    group: 'abzuege',
    default_hint: 'Ausgaben rund um die berufliche Tätigkeit.',
    effective_hint: 'Ausgaben rund um die berufliche Tätigkeit.',
    is_overridden: false,
    updated_at: null,
  },
  {
    slug: 'bescheid',
    name: 'Steuerbescheid',
    group: 'bescheid',
    default_hint: 'Bescheide und Mitteilungen des Finanzamts.',
    effective_hint: 'Bescheide und Mitteilungen des Finanzamts.',
    is_overridden: false,
    updated_at: null,
  },
]

const hintHandlers = [
  http.get('/api/documents/tax/hints', () => HttpResponse.json({ items: HINTS })),
  ...defaultHandlers,
]

const meta: Meta<typeof TaxSectionHintsView> = {
  title: 'Views/TaxSectionHintsView',
  component: TaxSectionHintsView,
  decorators: [routeFromParameters('/dokumente/steuer/hints')],
  parameters: { msw: { handlers: hintHandlers } },
}

export default meta
type Story = StoryObj<typeof TaxSectionHintsView>

export const MitHinweisen: Story = { name: 'Mit Hinweisen' }

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/tax/hints', async () => {
          await delay('infinite')
          return HttpResponse.json({ items: [] })
        }),
        ...hintHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/documents/tax/hints', () =>
          HttpResponse.json({ message: 'Hinweise nicht erreichbar' }, { status: 500 }),
        ),
        ...hintHandlers,
      ],
    },
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}
