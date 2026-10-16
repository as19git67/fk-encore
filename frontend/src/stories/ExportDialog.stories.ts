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
    http.get('/api/collections/:id/sends', () =>
      HttpResponse.json({
        mail_configured: true,
        sender_email: 'max@beispiel.test',
        system_sender: 'noreply@beispiel.test',
        self_sender_allowed: true,
        items: [
          {
            id: 1,
            export_id: 8,
            recipients: ['steuer@beispiel.test'],
            mode: 'attachment',
            filename: 'Nebenkosten 2026.zip',
            status: 'sent',
            error: null,
            sender: 'max@beispiel.test',
            sent_at: '2026-10-15T09:40:00Z',
            sent_by: 'Max Muster',
          },
        ],
      }),
    ),
    http.get('/api/collections/:id/schedules', () =>
      HttpResponse.json({
        items: [
          {
            id: 4,
            collection_id: 1,
            profile_id: 3,
            profile_name: 'Für den Vermieter',
            cadence: 'monthly',
            weekday: null,
            day: 1,
            month: null,
            scope: 'period',
            save_as_document: true,
            recipients: ['vermieter@beispiel.test'],
            sender: 'max@beispiel.test',
            send_as_self: true,
            single_files: false,
            message: null,
            enabled: true,
            next_run_at: '2026-11-01T04:00:00Z',
            last_run_at: '2026-10-01T04:00:00Z',
            last_status: 'done',
            last_error: null,
            last_export_id: 8,
            failures: 0,
            owner_name: 'Max Muster',
            can_edit: true,
          },
        ],
      }),
    ),
    http.get('/api/collections/exports/:exportId/entries', () =>
      HttpResponse.json({ items: [{ name: 'Dokumente/Abrechnung.pdf', size: 1000 }, { name: 'Fotos/Zaehler.jpg', size: 2000 }], single_files_allowed: true }),
    ),
    http.post('/api/collections/:id/exports', () =>
      HttpResponse.json(run(10, { filename: 'Nebenkosten 2026.zip', started_at: '2026-10-16T08:00:00Z' })),
    ),
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

/** Click what the dialog renders once it has loaded and enabled it (it lives in a teleport). */
async function clickWhenThere(root: Document, testId: string): Promise<void> {
  const selector = `[data-testid="${testId}"]`
  const ready = () => {
    const el = root.querySelector(selector) as HTMLButtonElement | null
    return el && !el.disabled ? el : null
  }
  for (let i = 0; i < 80 && !ready(); i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  ready()?.click()
}

/** After "Exportieren": the run in place of the form, with where it can go. */
export const Ergebnis: Story = {
  ...Gemischt,
  play: async ({ canvasElement }) => {
    await clickWhenThere(canvasElement.ownerDocument, 'export-start')
  },
}

/** The result with the mail form open: the sender is the user. */
export const ErgebnisPerMail: Story = {
  ...Gemischt,
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument
    await clickWhenThere(root, 'export-start')
    await clickWhenThere(root, 'export-mail-toggle')
  },
}

/** "Verlauf" with a run's "Weitergeben" panel opened: share, mail, link. */
export const Weitergeben: Story = {
  ...Gemischt,
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument
    await clickWhenThere(root, 'export-tab-history')
    await clickWhenThere(root, 'export-run-send')
  },
}

/** "Regelmäßig" with a new schedule's form: rhythm, scope, filing and recipients. */
export const NeuerZeitplan: Story = {
  ...Gemischt,
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument
    await clickWhenThere(root, 'export-tab-schedules')
    await clickWhenThere(root, 'schedule-add')
  },
}
