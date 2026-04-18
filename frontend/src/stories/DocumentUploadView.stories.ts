import type { Meta, StoryObj } from '@storybook/vue3'
import { h, onMounted } from 'vue'
import DocumentUploadView from '../views/DocumentUploadView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse, delay } from 'msw'
import { MOCK_DOCUMENTS } from './mock-data'

const meta: Meta<typeof DocumentUploadView> = {
  title: 'Views/DocumentUploadView',
  component: DocumentUploadView,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof DocumentUploadView>

function makePdfFile(name: string, sizeKb = 120): File {
  const body = new Uint8Array(sizeKb * 1024)
  body[0] = 0x25 // '%'
  body[1] = 0x50 // 'P'
  body[2] = 0x44 // 'D'
  body[3] = 0x46 // 'F'
  return new File([body], name, { type: 'application/pdf' })
}

function dispatchFiles(canvas: HTMLElement, files: File[]) {
  const input = canvas.querySelector<HTMLInputElement>('input[type=file]')
  if (!input) return
  const dt = new DataTransfer()
  for (const f of files) dt.items.add(f)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export const Leer: Story = {
  name: 'Leerer Upload-Bereich',
}

export const MitDateien: Story = {
  name: 'Dateien in Warteschlange',
  decorators: [
    (story) => ({
      components: { Story: story() },
      setup() {
        onMounted(() => {
          const input = document.querySelector<HTMLInputElement>('.upload-view input[type=file]')
          if (input) {
            const dt = new DataTransfer()
            dt.items.add(makePdfFile('rechnung_04_2024.pdf'))
            dt.items.add(makePdfFile('mietvertrag.pdf', 250))
            input.files = dt.files
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }
        })
        return () => h('Story')
      },
    }),
  ],
}

export const UploadErfolgreich: Story = {
  name: 'Upload erfolgreich',
  parameters: {
    msw: {
      handlers: [
        http.post('/api/documents', async () => {
          await delay(300)
          return HttpResponse.json(MOCK_DOCUMENTS[0]!)
        }),
        ...defaultHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    dispatchFiles(canvasElement, [makePdfFile('rechnung.pdf')])
    await new Promise((r) => setTimeout(r, 50))
    canvasElement.querySelector<HTMLButtonElement>('.queue-actions button')?.click()
  },
}

export const UploadDuplikat: Story = {
  name: 'Upload: bereits vorhanden',
  parameters: {
    msw: {
      handlers: [
        http.post('/api/documents', () =>
          HttpResponse.json(
            { code: 'already_exists', message: 'Dokument bereits hochgeladen.' },
            { status: 409 },
          ),
        ),
        ...defaultHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    dispatchFiles(canvasElement, [makePdfFile('duplikat.pdf')])
    await new Promise((r) => setTimeout(r, 50))
    canvasElement.querySelector<HTMLButtonElement>('.queue-actions button')?.click()
  },
}

export const UploadFehler: Story = {
  name: 'Upload schlägt fehl',
  parameters: {
    msw: {
      handlers: [
        http.post('/api/documents', () =>
          HttpResponse.json(
            { code: 'internal', message: 'Server-Fehler beim Verarbeiten' },
            { status: 500 },
          ),
        ),
        ...defaultHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    dispatchFiles(canvasElement, [makePdfFile('kaputt.pdf')])
    await new Promise((r) => setTimeout(r, 50))
    canvasElement.querySelector<HTMLButtonElement>('.queue-actions button')?.click()
  },
}

export const UngueltigerDateityp: Story = {
  name: 'Ungültiger Dateityp (nicht-PDF)',
  play: async ({ canvasElement }) => {
    const notPdf = new File(['hello'], 'notizen.txt', { type: 'text/plain' })
    dispatchFiles(canvasElement, [notPdf])
  },
}
