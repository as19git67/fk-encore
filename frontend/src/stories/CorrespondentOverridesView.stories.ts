import type { Meta, StoryObj } from '@storybook/vue3'
import CorrespondentOverridesView from '../views/CorrespondentOverridesView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'

const OVERRIDES = [
  { id: 1, sender_pattern: 'beispiel-versicherung', correspondent_display: 'Beispiel Versicherung', correspondent_slug: 'beispiel-versicherung' },
  // Deliberately long and unbroken: this is what used to widen the table past
  // a phone screen.
  { id: 2, sender_pattern: 'sehr-langer-absender-ohne-leerzeichen-im-namen', correspondent_display: 'Musterkasse Rhein-Main-Nord', correspondent_slug: 'musterkasse-rhein-main-nord-verwaltungsstelle' },
]

// The dev server proxies the API under /api; a production Storybook build
// resolves API_BASE_URL to the empty string. Register both so the story shows
// real rows either way.
const listOverrides = (items: typeof OVERRIDES) => [
  http.get('/api/documents/correspondent-overrides', () => HttpResponse.json({ items })),
  http.get('/documents/correspondent-overrides', () => HttpResponse.json({ items })),
]

const withOverrides = [...listOverrides(OVERRIDES), ...defaultHandlers]

const meta: Meta<typeof CorrespondentOverridesView> = {
  title: 'Views/CorrespondentOverridesView',
  component: CorrespondentOverridesView,
  parameters: {
    msw: { handlers: withOverrides },
  },
}

export default meta
type Story = StoryObj<typeof CorrespondentOverridesView>

export const MitOverrides: Story = {
  name: 'Korrespondenten-Overrides',
}

export const Schmal: Story = {
  name: 'Schmales Handy-Display',
  // The layout that matters: at this width the table is replaced by cards, so
  // the long slug wraps instead of widening the page. Pinned so the screenshot
  // run captures it narrow.
  parameters: {
    testViewport: { width: 375, height: 800 },
  },
}

export const Leer: Story = {
  name: 'Noch keine Overrides',
  parameters: {
    msw: {
      handlers: [...listOverrides([]), ...defaultHandlers],
    },
  },
}
