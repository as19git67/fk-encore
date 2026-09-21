import type { Meta, StoryObj } from '@storybook/vue3'
import LlmModelsView from '../views/LlmModelsView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { routeFromParameters } from './storyRoute'
import type { LlmConfigRow, LlmStatus, ModelFilesResponse } from '../api/llmModels'

/**
 * The local model behind the classification (issue #1281). Three states
 * matter: a model loaded and in sync, a configuration that has been
 * activated but not loaded yet, and an llm-service that cannot be reached
 * at all — the page has to stay usable in the last one.
 */

const CONFIG: LlmConfigRow = {
  id: 1,
  label: 'Klein und schnell',
  description: 'Reicht für die Klassifikation.',
  is_active: true,
  model_filename: 'beispiel-modell-q4.gguf',
  model_url: 'https://modelle.beispiel.test/beispiel-modell-q4.gguf',
  model_sha256: null,
  extra_urls: [],
  backend: 'server',
  accelerator: 'cpu',
  ctx_size: 8192,
  gpu_layers: 0,
  threads: 8,
  batch_size: 512,
  ubatch_size: 128,
  flash_attn: false,
  kv_type: 'q8_0',
  n_cpu_moe: 0,
  reasoning: 'off',
  server_extra_args: null,
  ready_timeout_s: 180,
  request_timeout_s: 120,
  app_timeout_ms: 120_000,
  created_at: '2025-05-01T08:00:00.000Z',
  updated_at: '2025-05-01T08:00:00.000Z',
}

const IDLE_DOWNLOAD = {
  state: 'idle',
  filename: '',
  url: '',
  bytes_done: 0,
  bytes_total: null,
  percent: null,
  eta_seconds: null,
  bytes_per_second: null,
  file_index: 0,
  file_count: 0,
  error: null,
  completed: [],
}

const STATUS: LlmStatus = {
  intended: CONFIG,
  live: {
    model_filename: CONFIG.model_filename,
    backend: 'server',
    accelerator: 'cpu',
    ctx_size: 8192,
    gpu_layers: 0,
    n_cpu_moe: 0,
    kv_type: 'q8_0',
    flash_attn: false,
    label: CONFIG.label,
    config_id: CONFIG.id,
    source: 'file',
    model_present: true,
  },
  reload: {
    state: 'ready',
    detail: null,
    label: CONFIG.label,
    started_at: 1_750_000_000,
    finished_at: 1_750_000_060,
  },
  download: IDLE_DOWNLOAD,
  llm_loaded: true,
  in_sync: true,
}

const FILES: ModelFilesResponse = {
  files: [
    {
      filename: CONFIG.model_filename,
      size_bytes: 4_100_000_000,
      modified_at: 1_750_000_000,
      partial: false,
    },
  ],
  active_filename: CONFIG.model_filename,
  models_dir: '/data/models',
  disk: { total_bytes: 500_000_000_000, free_bytes: 120_000_000_000 },
  download: IDLE_DOWNLOAD,
}

const llmHandlers = [
  http.get('/api/admin/llm-configs', () => HttpResponse.json({ configs: [CONFIG] })),
  http.get('/api/admin/llm-status', () => HttpResponse.json(STATUS)),
  http.get('/api/admin/llm-models/files', () => HttpResponse.json(FILES)),
  ...defaultHandlers,
]

const meta: Meta<typeof LlmModelsView> = {
  title: 'Views/LlmModelsView',
  component: LlmModelsView,
  decorators: [routeFromParameters('/dokumente/ki-modell')],
  parameters: { msw: { handlers: llmHandlers } },
}

export default meta
type Story = StoryObj<typeof LlmModelsView>

export const ModellGeladen: Story = { name: 'Modell geladen' }

export const NichtGeladen: Story = {
  name: 'Konfiguration aktiv, Modell nicht geladen',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/llm-status', () =>
          HttpResponse.json({
            ...STATUS,
            llm_loaded: false,
            in_sync: false,
            live: { ...STATUS.live, model_present: false, source: 'env' },
            reload: { ...STATUS.reload, state: 'idle', finished_at: null },
          }),
        ),
        ...llmHandlers,
      ],
    },
  },
}

export const DienstNichtErreichbar: Story = {
  name: 'llm-service nicht erreichbar',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/llm-status', () =>
          HttpResponse.json({ message: 'llm-service nicht erreichbar' }, { status: 503 }),
        ),
        http.get('/api/admin/llm-models/files', () =>
          HttpResponse.json({ message: 'llm-service nicht erreichbar' }, { status: 503 }),
        ),
        ...llmHandlers,
      ],
    },
  },
}

export const OhneKonfiguration: Story = {
  name: 'Noch keine Konfiguration',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/llm-configs', () => HttpResponse.json({ configs: [] })),
        ...llmHandlers,
      ],
    },
  },
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/admin/llm-configs', async () => {
          await delay('infinite')
          return HttpResponse.json({ configs: [] })
        }),
        ...llmHandlers,
      ],
    },
  },
}
