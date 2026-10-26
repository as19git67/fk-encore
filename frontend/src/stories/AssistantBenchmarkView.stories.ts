import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import AssistantBenchmarkView from '../views/AssistantBenchmarkView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { BenchRunDetail, BenchRunSummary, FeedbackEntry } from '../api/assistantBenchmark'

/** The assistant benchmark page: a finished run with its cases, and a run in progress. */

const CASES = [
  { id: 'debits-this-month', title: 'Lastschriften bis Monatsende', question: 'Welche Lastschriften muss ich in diesem Monat noch erwarten?', tools: ['upcoming_payments'] },
  { id: 'report-with-yield', title: 'Bericht mit Gruppen und Rendite', question: 'Liste alle Buchungen zur Wohnung …', tools: ['transaction_report'] },
  { id: 'letter-paid-invoices', title: 'Brief aus drei Rechnungen, Lücke für das Unbekannte', question: 'Schreib der Musterfirma …', tools: ['render_letter'] },
]

const MODEL = { label: 'Beispielmodell 26B', model_filename: 'beispielmodell-26b-q4.gguf', backend: 'server', ctx_size: 16384, accelerator: 'cuda', gpu_layers: 99, source: 'file' }

const DONE: BenchRunDetail = {
  id: 2,
  label: 'Beispielmodell 26B',
  model: MODEL,
  status: 'done',
  cases_total: 3,
  cases_done: 3,
  current_case: null,
  error: null,
  started_at: '2026-10-16T08:00:00Z',
  finished_at: '2026-10-16T08:03:10Z',
  summary: {
    cases: 3, passed: 2, tool_hit_rate: 1, args_hit_rate: 0.67, pass_rate: 0.67, errors: 0, rounds: 7,
    median_ms_per_round: 2140, p90_ms_per_round: 6310, median_rounds_per_case: 2, max_rounds_used: 3,
    first_tool_hit_rate: 0.67, nudges: 1, median_prompt_tokens_first: 6120,
  },
  results: [
    {
      id: 'debits-this-month', title: 'Lastschriften bis Monatsende', rounds_ms: [1820, 2140],
      calls: [{ tool: 'upcoming_payments', args: { until: '2026-10-31', channel: 'direct_debit' } }],
      answer: 'Bis Ende Oktober kommen noch zwei Lastschriften, zusammen 116,50 €.', error: null,
      score: { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [], first_tool_hit: true },
      rounds: 2, first_tool: 'upcoming_payments', nudges: 0, prompt_tokens_first: 5980,
    },
    {
      id: 'report-with-yield', title: 'Bericht mit Gruppen und Rendite', rounds_ms: [2300, 6310, 1900],
      calls: [
        { tool: 'list_transactions', args: { q: 'Beispielweg' } },
        { tool: 'transaction_report', args: { title: 'Wohnung Beispielweg', groups: [{ name: 'Kauf', transaction_ids: [801, 802] }, { name: 'Mieteinnahmen', transaction_ids: [804, 805] }] } },
      ],
      answer: 'Der Bericht liegt als Vorschlag bereit.', error: null,
      score: { tool_hit: true, args_hit: false, answered: true, passed: false, missing: ['transaction_report'], first_tool_hit: true },
      rounds: 3, first_tool: 'list_transactions', nudges: 1, prompt_tokens_first: 6120,
    },
    {
      id: 'letter-paid-invoices', title: 'Brief aus drei Rechnungen, Lücke für das Unbekannte', rounds_ms: [3900, 1500],
      calls: [{ tool: 'render_letter', args: { recipient: 'Musterfirma Haustechnik GmbH\nBeispielstraße 1\n12345 Musterstadt', body: 'Sehr geehrte Damen und Herren, … RE-2026-0101 … 89,90 € … am [[Zahlungsdatum]] …' } }],
      answer: 'Der Brief wartet auf der Karte; bitte das Zahlungsdatum ergänzen.', error: null,
      score: { tool_hit: true, args_hit: true, answered: true, passed: true, missing: [], first_tool_hit: false },
      rounds: 2, first_tool: 'search_documents', nudges: 0, prompt_tokens_first: 6400,
    },
  ],
}

/** What users judged under an answer: a wrong road and a good one. */
const FEEDBACK: FeedbackEntry[] = [
  {
    id: 2, verdict: 'down', comment: 'Das war die falsche Suche, ich wollte die Steuerunterlagen.',
    question: 'Welche Unterlagen brauche ich für die Steuer 2025?',
    trace: [
      { tool: 'search_documents', arguments: { q: 'Steuer 2025' }, rows: 0, error: null },
      { tool: 'search_documents', arguments: { q: 'Steuer' }, rows: 14, error: null },
    ],
    answer: 'Ich habe 14 Dokumente gefunden, in denen es um Steuern geht.',
    conversation_id: 12, message_id: 341, created_at: '2026-10-25T18:12:00Z',
    case_draft: '{\n  "id": "feedback-2"\n}',
  },
  {
    id: 1, verdict: 'up', comment: null,
    question: 'Wie viel Strom haben wir letztes Jahr verbraucht?',
    trace: [
      { tool: 'list_meters', arguments: {}, rows: 2, error: null },
      { tool: 'consumption_report', arguments: { meter_id: 3, from: '2025-01-01', to: '2025-12-31' }, rows: 1, error: null },
    ],
    answer: 'Der Zähler „Strom Haus“ zeigt für 2025 einen Verbrauch von 3.412 kWh.',
    conversation_id: null, message_id: null, created_at: '2026-10-24T07:40:00Z',
    case_draft: '{\n  "id": "feedback-1"\n}',
  },
]

const OLDER: BenchRunSummary = {
  ...DONE, id: 1, label: 'CPU-Fallback 7B', model: { ...MODEL, label: 'CPU-Fallback 7B', model_filename: 'fallback-7b-q4.gguf', backend: 'inproc', ctx_size: 8192 },
  started_at: '2026-10-15T18:00:00Z',
  summary: { ...DONE.summary!, passed: 1, args_hit_rate: 0.33, pass_rate: 0.33, median_ms_per_round: 14200, p90_ms_per_round: 31000 },
}

const summaryOf = ({ results: _r, ...rest }: BenchRunDetail): BenchRunSummary => rest

/** The same cases on the CPU twin, as the model runs at night while the GPU scores photos. */
const CPU_TWIN: BenchRunSummary = {
  ...summaryOf(DONE), id: 4, label: 'Beispielmodell 26B (CPU)',
  model: { ...MODEL, label: 'Beispielmodell 26B (CPU)', accelerator: 'cpu', gpu_layers: 0, source: 'lease' },
  started_at: '2026-10-17T01:10:00Z', finished_at: '2026-10-17T01:21:40Z',
  summary: { ...DONE.summary!, median_ms_per_round: 9800, p90_ms_per_round: 24500 },
}

const handlers = (runs: BenchRunSummary[], detail: BenchRunDetail) => [
  http.get('/api/assistant/benchmark/cases', () => HttpResponse.json({ today: '2026-10-15', cases: CASES })),
  http.get('/api/assistant/benchmark/runs', () => HttpResponse.json({ runs })),
  http.get('/api/assistant/benchmark/runs/:id', () => HttpResponse.json(detail)),
  http.get('/api/assistant/feedback', () => HttpResponse.json({ entries: FEEDBACK })),
  ...defaultHandlers,
]

const RUNNING: BenchRunDetail = {
  ...DONE, id: 3, status: 'running', cases_done: 1, current_case: 'report-with-yield', summary: null, finished_at: null,
  started_at: '2026-10-16T09:00:00Z', results: DONE.results.slice(0, 1),
}

const meta: Meta<typeof AssistantBenchmarkView> = {
  title: 'Views/AssistantBenchmarkView',
  component: AssistantBenchmarkView,
  decorators: [routeFromParameters('/dokumente/ki-benchmark')],
  parameters: { msw: { handlers: handlers([CPU_TWIN, summaryOf(DONE), OLDER], DONE) } },
}

export default meta
type Story = StoryObj<typeof AssistantBenchmarkView>

export const Fertig: Story = { name: 'Fertiger Lauf mit Verlauf' }

export const Laeuft: Story = {
  name: 'Lauf in Arbeit auf dem Telefon',
  parameters: {
    testViewport: { width: 390, height: 844 },
    msw: { handlers: handlers([summaryOf(RUNNING), summaryOf(DONE), OLDER], RUNNING) },
  },
}

export const GpuWirdVerliehen: Story = {
  name: 'Lauf auf dem CPU-Zwilling, GPU wird gerade verliehen',
  parameters: {
    msw: {
      handlers: handlers(
        [summaryOf({ ...RUNNING, id: 5, label: 'Beispielmodell 26B (CPU)', cases_done: 0, current_case: 'gpu:lend', results: [] }), CPU_TWIN, summaryOf(DONE)],
        { ...RUNNING, id: 5, label: 'Beispielmodell 26B (CPU)', cases_done: 0, current_case: 'gpu:lend', results: [] },
      ),
    },
  },
}

export const Leer: Story = {
  name: 'Noch kein Lauf',
  parameters: { msw: { handlers: handlers([], DONE) } },
}
