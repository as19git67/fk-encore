import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse, delay } from 'msw'
import AssistantView from '../views/AssistantView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import { CONVERSATION } from './assistant-mock-data'

/**
 * The assistant's page (#1528): empty with suggested questions, a
 * conversation with result blocks, and the states around them. The answer
 * stream is a WebSocket the stories cannot serve; the page falls back to the
 * POST's answer, which is what a lost socket does in the app too.
 */

const summaries = [
  { id: 1, title: CONVERSATION.title, created_at: CONVERSATION.created_at, updated_at: CONVERSATION.updated_at },
  { id: 2, title: 'Urlaubsreisen letztes Jahr und eine sehr lange Frage danach', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:02:00Z' },
]

const handlers = [
  http.get('/api/assistant/conversations', () => HttpResponse.json({ conversations: summaries })),
  http.get('/api/assistant/conversations/:id', () => HttpResponse.json(CONVERSATION)),
  http.post('/api/assistant/conversations', () =>
    HttpResponse.json({ id: 3, title: null, created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z' })),
  http.post('/api/assistant/conversations/:id/ask', () =>
    HttpResponse.json({ answer: 'Dazu habe ich nichts gefunden.', blocks: [], message_id: 99, rounds: 1 })),
  ...defaultHandlers,
]

const meta: Meta<typeof AssistantView> = {
  title: 'Views/AssistantView',
  component: AssistantView,
  decorators: [routeFromParameters('/assistent')],
  parameters: { msw: { handlers } },
}

export default meta
type Story = StoryObj<typeof AssistantView>

export const Leer: Story = {
  name: 'Leer mit Vorschlägen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/assistant/conversations', () => HttpResponse.json({ conversations: [] })),
        ...handlers,
      ],
    },
  },
}

export const MitUnterhaltung: Story = {
  name: 'Unterhaltung mit Ergebnissen',
  parameters: { route: '/assistent?c=1' },
}

export const Schmal: Story = {
  name: 'Unterhaltung auf dem Telefon',
  parameters: { route: '/assistent?c=1', testViewport: { width: 390, height: 844 } },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    route: '/assistent?c=1',
    msw: {
      handlers: [
        http.get('/api/assistant/conversations/:id', async () => {
          await delay('infinite')
          return HttpResponse.json(CONVERSATION)
        }),
        ...handlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/assistant/conversations', () => HttpResponse.json({ code: 'internal', message: 'Serverfehler' }, { status: 500 })),
        ...handlers,
      ],
    },
  },
}
