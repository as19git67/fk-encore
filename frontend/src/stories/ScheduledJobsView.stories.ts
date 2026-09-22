import type { Meta, StoryObj } from '@storybook/vue3'
import ScheduledJobsView from '../views/ScheduledJobsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { ScheduledJob } from '../api/admin'

/**
 * The background jobs (issue #1281). A job that last failed and a job that
 * is paused are the two rows an admin actually looks for, so both are here.
 */

const JOBS: ScheduledJob[] = [
  {
    name: 'photo-scan',
    description: 'Sucht neue Fotos in den Bibliotheken.',
    service: 'photos',
    schedule_label: 'alle 15 Minuten',
    status: 'ok',
    enabled: true,
    next_fire_at: '2026-09-21T16:00:00.000Z',
    last_run_at: '2026-09-21T15:45:00.000Z',
    last_duration_ms: 4200,
    last_error: null,
    run_count: 1842,
    error_count: 0,
  },
  {
    name: 'document-classify',
    description: 'Klassifiziert neue Dokumente.',
    service: 'documents',
    schedule_label: 'stündlich',
    status: 'running',
    enabled: true,
    next_fire_at: '2026-09-21T16:30:00.000Z',
    last_run_at: '2026-09-21T15:30:00.000Z',
    last_duration_ms: 91_000,
    last_error: 'Das Modell hat nicht geantwortet.',
    run_count: 212,
    error_count: 3,
  },
  {
    name: 'finance-sync',
    description: 'Holt Umsätze bei den Bankkontakten ab.',
    service: 'finance',
    schedule_label: 'täglich 07:30',
    status: 'paused',
    enabled: false,
    next_fire_at: null,
    last_run_at: '2026-09-18T05:30:00.000Z',
    last_duration_ms: 18_000,
    last_error: null,
    run_count: 96,
    error_count: 1,
  },
]

const jobHandlers = [
  http.get('/api/admin/scheduled-jobs', () => HttpResponse.json({ jobs: JOBS })),
  ...defaultHandlers,
]

const meta: Meta<typeof ScheduledJobsView> = {
  title: 'Views/ScheduledJobsView',
  component: ScheduledJobsView,
  decorators: [routeFromParameters('/admin/jobs')],
  parameters: { msw: { handlers: jobHandlers } },
}

export default meta
type Story = StoryObj<typeof ScheduledJobsView>

export const MitJobs: Story = { name: 'Mit Jobs' }

export const KeineJobs: Story = {
  name: 'Keine Jobs',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/scheduled-jobs', () => HttpResponse.json({ jobs: [] })),
        ...jobHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/scheduled-jobs', async () => {
          await delay('infinite')
          return HttpResponse.json({ jobs: [] })
        }),
        ...jobHandlers,
      ],
    },
  },
}

export const Ladefehler: Story = {
  name: 'Ladefehler',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/scheduled-jobs', () =>
          HttpResponse.json({ message: 'Jobs nicht erreichbar' }, { status: 500 }),
        ),
        ...jobHandlers,
      ],
    },
  },
}
