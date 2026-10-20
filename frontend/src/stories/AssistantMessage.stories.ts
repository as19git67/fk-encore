import type { Meta, StoryObj } from '@storybook/vue3'
import AssistantMessage from '../components/assistant/AssistantMessage.vue'
import { http, HttpResponse } from 'msw'
import { defaultHandlers } from './handlers'
import {
  ANALYSIS_BLOCK,
  DEBITS_BLOCK,
  DOCUMENTS_BLOCK,
  METERS_BLOCK,
  PHOTOS_BLOCK,
  PROPOSAL_DISCARDED_BLOCK,
  PROPOSAL_EXECUTED_BLOCK,
  PROPOSAL_FAILED_BLOCK,
  PROPOSAL_LETTER_BLOCK,
  PROPOSAL_PENDING_BLOCK,
  PROPOSAL_REPORT_BLOCK,
  RECAPS_BLOCK,
  TABLE_BLOCK,
  TRANSACTIONS_BLOCK,
} from './assistant-mock-data'

/**
 * One message of the assistant (#1528) and every kind of result block it
 * can carry. Each row opens its object; "In der Liste öffnen" opens the list
 * page with the same filters.
 */
const meta: Meta<typeof AssistantMessage> = {
  title: 'Assistant/AssistantMessage',
  component: AssistantMessage,
  parameters: { msw: { handlers: defaultHandlers } },
  decorators: [() => ({ template: '<div style="padding: 1rem; max-width: 48rem"><story /></div>' })],
}

export default meta
type Story = StoryObj<typeof AssistantMessage>

export const Frage: Story = {
  name: 'Frage',
  args: { role: 'user', content: 'Wie viel haben wir im September für Lebensmittel ausgegeben?' },
}

export const Buchungen: Story = {
  name: 'Antwort mit Buchungen',
  args: { role: 'assistant', content: 'Ich habe 14 Buchungen an die Stadtwerke gefunden.', blocks: [TRANSACTIONS_BLOCK] },
}

export const Lastschriften: Story = {
  name: 'Antwort mit Lastschriften',
  args: { role: 'assistant', content: 'Bis Monatsende kommen noch zwei Lastschriften.', blocks: [DEBITS_BLOCK] },
}

export const Dokumente: Story = {
  name: 'Antwort mit Dokumenten',
  args: { role: 'assistant', content: 'Zwei Protokolle passen.', blocks: [DOCUMENTS_BLOCK] },
}

export const Fotos: Story = {
  name: 'Antwort mit Fotos',
  args: { role: 'assistant', content: '143 favorisierte Fotos aus 2025.', blocks: [PHOTOS_BLOCK] },
}

export const Rueckblicke: Story = {
  name: 'Antwort mit Rückblicken und Zählern',
  args: { role: 'assistant', content: 'Zwei Reisen letztes Jahr.', blocks: [RECAPS_BLOCK, METERS_BLOCK] },
}

export const Auswertung: Story = {
  name: 'Antwort mit Auswertung und Tabelle',
  args: { role: 'assistant', content: 'Im September waren es 412,37 €.', blocks: [ANALYSIS_BLOCK, TABLE_BLOCK] },
}

export const Laeuft: Story = {
  name: 'Antwort entsteht',
  args: {
    role: 'assistant',
    content: '',
    pending: true,
    steps: [
      { tool: 'list_categories', label: 'Kategorien ansehen', done: true, rowCount: 42 },
      { tool: 'search_documents', label: 'Dokumente durchsuchen', done: false },
    ],
  },
}

export const Fehler: Story = {
  name: 'Werkzeug fehlgeschlagen',
  args: {
    role: 'assistant',
    content: 'Den Zähler konnte ich nicht lesen.',
    steps: [{ tool: 'latest_readings', label: 'Zählerstände lesen', done: true, error: 'meter not found' }],
  },
}

const executed = PROPOSAL_EXECUTED_BLOCK.rows[0]
const discarded = PROPOSAL_DISCARDED_BLOCK.rows[0]

/** Write actions (#1529): the card waits for "Ausführen" or "Verwerfen". */
export const Vorschlag: Story = {
  name: 'Vorschlag: wartet auf Bestätigung',
  parameters: {
    msw: {
      handlers: [
        http.post('/api/assistant/proposals/:id/execute', () => HttpResponse.json({ ...executed, proposal_id: 1 })),
        http.post('/api/assistant/proposals/:id/discard', () => HttpResponse.json({ ...discarded, proposal_id: 1 })),
        ...defaultHandlers,
      ],
    },
  },
  args: {
    role: 'assistant',
    content: 'Ich habe das Album „Favoriten 2025“ mit 143 Fotos vorgeschlagen. Es wird erst angelegt, wenn du „Ausführen“ drückst.',
    blocks: [PROPOSAL_PENDING_BLOCK],
  },
}

export const VorschlagAusgefuehrt: Story = {
  name: 'Vorschlag: ausgeführt, verworfen, fehlgeschlagen',
  args: {
    role: 'assistant',
    content: 'Drei Vorschläge in verschiedenen Zuständen.',
    blocks: [PROPOSAL_EXECUTED_BLOCK, PROPOSAL_DISCARDED_BLOCK, PROPOSAL_FAILED_BLOCK],
  },
}

export const VorschlagBericht: Story = {
  name: 'Vorschlag: Bericht mit PDF',
  args: {
    role: 'assistant',
    content: 'Der Bericht ist gespeichert. Die Rendite beträgt laut Bericht 1,81 %.',
    blocks: [PROPOSAL_REPORT_BLOCK],
  },
}

export const VorschlagBrief: Story = {
  name: 'Vorschlag: Brief zum Bearbeiten',
  args: {
    role: 'assistant',
    content: 'Der Brief liegt als Vorschlag bereit. Bitte das Zahlungsdatum und deine Anschrift ergänzen.',
    blocks: [PROPOSAL_LETTER_BLOCK],
  },
}

export const TabelleImText: Story = {
  name: 'Antwort mit Tabelle im Text',
  args: {
    role: 'assistant',
    content: [
      'Der Verbrauch der letzten drei Jahre:',
      '',
      '| Jahr | Strom | Wasser |',
      '|------|------:|-------:|',
      '| 2023 | 3.410 kWh | 92 m³ |',
      '| 2024 | 3.188 kWh | 88 m³ |',
      '| **2025** | 2.957 kWh | 85 m³ |',
      '',
      'Der Stromverbrauch sinkt seit 2023.',
    ].join('\n'),
  },
}

export const AsciiTabelle: Story = {
  name: 'Antwort mit ASCII-Tabelle',
  args: {
    role: 'assistant',
    content: [
      'Die Zähler im Überblick:',
      '```',
      '+-------------+-----------+------------------+',
      '| Zähler      | Einheit   | Letzter Stand    |',
      '+-------------+-----------+------------------+',
      '| Strom Haus  | kWh       | 41.207,5         |',
      '| Wasser      | m³        | 1.033            |',
      '+-------------+-----------+------------------+',
      '```',
    ].join('\n'),
  },
}
