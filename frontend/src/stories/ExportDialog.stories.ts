import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import ExportDialog from '../components/collections/ExportDialog.vue'
import { defaultHandlers } from './handlers'
import type { ExportOptions, ExportRun, ExportSetup } from '../api/collections'

/**
 * "Exportieren" for a collection (#1548, stage 6): a block per kind it holds,
 * a profile to keep the choice, and the reader's recent runs.
 */

const DEFAULTS: ExportOptions = {
  document: { format: 'pdf' },
  transaction: {
    format: 'pdf',
    columns: ['booking_date', 'account', 'counterparty', 'purpose', 'amount', 'currency', 'tags'],
    group_by_account: true,
    account_order: [],
  },
  photo: { size: 'original', strip_metadata: false },
  album: { size: 'original', strip_metadata: false },
  security: { format: 'pdf' },
  meter: { format: 'pdf', from: null, to: null },
  always_zip: false,
}

function run(id: number, extra: Partial<ExportRun>): ExportRun {
  return {
    id,
    collection_id: 1,
    status: 'done',
    profile_id: null,
    filename: 'Nebenkosten 2026.zip',
    mime_type: 'application/zip',
    size_bytes: 4_200_000,
    item_count: 18,
    skipped: [],
    error: null,
    document_id: null,
    started_at: '2026-10-15T09:30:00Z',
    finished_at: '2026-10-15T09:30:20Z',
    expires_at: '2026-10-22T09:30:00Z',
    ...extra,
  }
}

function handlers(setup: ExportSetup, runs: ExportRun[]) {
  return [
    http.get('/api/collections/:id/export-setup', () => HttpResponse.json(setup)),
    http.get('/api/collections/:id/exports', () => HttpResponse.json({ items: runs })),
    http.get('/api/collections/exports/:exportId', ({ params }) =>
      HttpResponse.json(runs.find((r) => r.id === Number(params.exportId)) ?? runs[0]),
    ),
    ...defaultHandlers,
  ]
}

const meta: Meta<typeof ExportDialog> = {
  title: 'Components/ExportDialog',
  component: ExportDialog,
  args: { visible: true, collectionId: 1, name: 'Nebenkosten 2026' },
}

export default meta
type Story = StoryObj<typeof ExportDialog>

/** Documents, bookings, photos and a meter: a ZIP with a folder per kind. */
export const Gemischt: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          groups: { document: 4, transaction: 12, photo: 6, meter: 2 },
          defaults: DEFAULTS,
          profiles: [{ id: 3, name: 'Für den Vermieter', options: DEFAULTS, updated_at: '2026-10-01T00:00:00Z' }],
          accounts: [
            { id: 1, label: 'Girokonto' },
            { id: 2, label: 'Kreditkarte' },
          ],
        },
        [
          run(9, { status: 'running', filename: null, size_bytes: null, item_count: 0, finished_at: null }),
          run(8, {
            skipped: [
              { entity_type: 'document', entity_id: 21, reason: 'switched_off' },
              { entity_type: 'photo', entity_id: 40, reason: 'file_missing' },
            ],
          }),
          run(7, { status: 'failed', filename: null, size_bytes: null, item_count: 0, error: 'Der Export wurde unterbrochen. Bitte neu starten.' }),
        ],
      ),
    },
  },
}

/** Only bookings: one file, columns and account order to choose. */
export const NurBuchungen: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          groups: { transaction: 40 },
          defaults: DEFAULTS,
          profiles: [],
          accounts: [
            { id: 1, label: 'Girokonto' },
            { id: 2, label: 'Kreditkarte' },
            { id: 3, label: 'Tagesgeld' },
          ],
        },
        [run(5, { filename: 'Steuer 2026 - Buchungen.pdf', mime_type: 'application/pdf', size_bytes: 180_000, item_count: 40 })],
      ),
    },
  },
}

export const Leer: Story = {
  parameters: {
    msw: { handlers: handlers({ groups: {}, defaults: DEFAULTS, profiles: [], accounts: [] }, []) },
  },
}
