import type { Meta, StoryObj } from '@storybook/vue3'
import TaxonomyToolsView from '../views/TaxonomyToolsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'

/**
 * The taxonomy tools (issue #1281): long-running jobs an admin starts by
 * hand. A tool that is already running must be visibly different from one
 * waiting to be started, or it gets started twice.
 */

const toolHandlers = [
  http.get('/api/admin/tools/status', () =>
    HttpResponse.json({
      tools: [
        { tool: 'reclassify', running: false },
        { tool: 'scoreboard', running: true },
        { tool: 'taxonomy-audit', running: false },
      ],
    }),
  ),
  http.get('/api/admin/tools/reports/:tool', () => HttpResponse.json({ files: [] })),
  ...defaultHandlers,
]

const meta: Meta<typeof TaxonomyToolsView> = {
  title: 'Views/TaxonomyToolsView',
  component: TaxonomyToolsView,
  decorators: [routeFromParameters('/dokumente/taxonomie-tools')],
  parameters: { msw: { handlers: toolHandlers } },
}

export default meta
type Story = StoryObj<typeof TaxonomyToolsView>

export const EinWerkzeugLaeuft: Story = { name: 'Ein Werkzeug läuft' }

export const AllesStill: Story = {
  name: 'Alles still',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/tools/status', () =>
          HttpResponse.json({
            tools: [
              { tool: 'reclassify', running: false },
              { tool: 'scoreboard', running: false },
              { tool: 'taxonomy-audit', running: false },
            ],
          }),
        ),
        ...toolHandlers,
      ],
    },
  },
}

export const MitBerichten: Story = {
  name: 'Mit Berichten',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/tools/reports/:tool', () =>
          HttpResponse.json({
            files: [
              { name: 'scoreboard-2025-06-01.json', size: 18_432 },
              { name: 'scoreboard-2025-05-01.json', size: 17_988 },
            ],
          }),
        ),
        ...toolHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/tools/status', async () => {
          await delay('infinite')
          return HttpResponse.json({ tools: [] })
        }),
        ...toolHandlers,
      ],
    },
  },
}
