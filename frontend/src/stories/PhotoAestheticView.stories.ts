import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import PhotoAestheticView from '../views/PhotoAestheticView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { AestheticHeadReport, AestheticOverview, AestheticRun } from '../api/photoAesthetic'

/** Fotos › Einstellungen › Ästhetik: the nightly Q-Align run on the lent GPU. */

const NIGHT: AestheticRun = {
  id: 3, trigger: 'window', status: 'done', phase: null, model: 'qalign_v1', backlog: 18420, scored: 17950, failed: 12,
  remaining: 458, ended_reason: 'Zeitfenster zu Ende', error: null, gpu_returned: true,
  started_at: '2026-10-20T23:05:00Z', ended_at: '2026-10-21T04:00:00Z',
}

const MANUAL: AestheticRun = {
  ...NIGHT, id: 2, trigger: 'manual', status: 'stopped', backlog: 20000, scored: 1580, failed: 0, remaining: 18420,
  ended_reason: 'Angehalten', started_at: '2026-10-20T15:10:00Z', ended_at: '2026-10-20T15:24:00Z',
}

const FAILED: AestheticRun = {
  ...NIGHT, id: 1, status: 'failed', backlog: 20000, scored: 0, failed: 0, remaining: 20000, ended_reason: null,
  error: 'Der Scorer meldet einen Fehler: CUDA out of memory', gpu_returned: false,
  started_at: '2026-10-19T23:05:00Z', ended_at: '2026-10-19T23:20:00Z',
}

const HEAD: AestheticHeadReport = {
  version: 'vith_head_v1', active: true, trained_at: '2026-10-21T04:12:00Z', samples: 17950, train: 12565,
  validation: 2692, test: 2693, ridge_lambda: 100, spearman_head: 0.74, spearman_zero_shot: 0.36, mae_head: 0.06,
}

const BASE: AestheticOverview = {
  settings: { enabled: true, window_start: '01:00', window_end: '06:00', composite: null, updated_at: '2026-10-20T15:00:00Z' },
  time_zone: 'Europe/Berlin',
  in_window: false,
  model: 'qalign_v1',
  scored: 19530,
  backlog: 458,
  active_run_id: null,
  runs: [NIGHT, MANUAL, FAILED],
  scorer: { state: 'unloaded', error: null, version: null },
  scorer_error: null,
  head: HEAD,
  head_error: null,
  head_pending: 0,
  head_job: {
    trigger: 'after_run', status: 'done', phase: null, applied: 458, without_vector: 3, note: null, error: null,
    report: HEAD, started_at: '2026-10-21T04:01:00Z', ended_at: '2026-10-21T04:13:00Z',
  },
}

const RUNNING: AestheticOverview = {
  ...BASE,
  in_window: true,
  active_run_id: 4,
  scorer: { state: 'loaded', error: null, version: 'qalign_v1' },
  runs: [
    { ...NIGHT, id: 4, status: 'running', phase: 'scoring', backlog: 458, scored: 212, failed: 1, remaining: null, ended_reason: null, ended_at: null, gpu_returned: false, started_at: new Date(Date.now() - 23 * 60_000).toISOString() },
    NIGHT,
    MANUAL,
  ],
}

const handlers = (overview: AestheticOverview) => [
  http.get('/api/photos/aesthetic', () => HttpResponse.json(overview)),
  ...defaultHandlers,
]

const meta: Meta<typeof PhotoAestheticView> = {
  title: 'Views/PhotoAestheticView',
  component: PhotoAestheticView,
  decorators: [routeFromParameters('/fotos/einstellungen/aesthetik')],
  parameters: { msw: { handlers: handlers(BASE) } },
}

export default meta
type Story = StoryObj<typeof PhotoAestheticView>

export const Stand: Story = { name: 'Tagsüber, mit Verlauf' }

export const Laeuft: Story = {
  name: 'Nachtlauf in Arbeit auf dem Telefon',
  parameters: {
    testViewport: { width: 390, height: 844 },
    msw: { handlers: handlers(RUNNING) },
  },
}

export const DienstFehlt: Story = {
  name: 'Ästhetik-Dienst antwortet nicht, noch kein Lauf',
  parameters: {
    msw: {
      handlers: handlers({
        ...BASE,
        settings: { ...BASE.settings, enabled: false },
        scored: 0,
        backlog: 20000,
        runs: [],
        scorer: null,
        scorer_error: 'aesthetic-service unreachable at http://aesthetic_service:8000/status: fetch failed',
        head: null,
        head_pending: null,
        head_job: null,
      }),
    },
  },
}

export const KopfUngenutzt: Story = {
  name: 'Vorläufiger Wert schlechter als CLIP, lernt gerade neu',
  parameters: {
    msw: {
      handlers: handlers({
        ...BASE,
        head: { ...HEAD, active: false, samples: 640, test: 96, spearman_head: 0.31, spearman_zero_shot: 0.35 },
        head_pending: null,
        head_job: {
          trigger: 'manual', status: 'running', phase: 'train', applied: 0, without_vector: 0, note: null, error: null,
          report: null, started_at: new Date().toISOString(), ended_at: null,
        },
      }),
    },
  },
}
