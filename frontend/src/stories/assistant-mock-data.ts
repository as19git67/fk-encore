/**
 * Synthetic data for the assistant's stories (#1528): blocks of every kind
 * as the server sends them. Names, places and numbers are made up.
 */
import type { ConversationDetail, ResultBlock } from '../api/assistant'

export const TRANSACTIONS_BLOCK: ResultBlock = {
  kind: 'transactions',
  tool: 'list_transactions',
  total: 14,
  subtitle: 'Girokonto · Saldo 1234.56 EUR',
  route: '/finanzen/uebersicht/konto/1?q=Stadtwerke&dateFrom=2026-01-01&dateTo=2026-09-30',
  rows: [
    { id: 501, booking_date: '2026-09-20', amount: '-84.00', counterparty: 'Stadtwerke Musterstadt', purpose: 'Abschlag Strom September' },
    { id: 502, booking_date: '2026-08-20', amount: '-84.00', counterparty: 'Stadtwerke Musterstadt', purpose: 'Abschlag Strom August' },
    { id: 503, booking_date: '2026-07-31', amount: '112.40', counterparty: 'Stadtwerke Musterstadt', purpose: 'Erstattung aus der Jahresabrechnung mit einem recht langen Verwendungszweck' },
  ],
}

export const DEBITS_BLOCK: ResultBlock = {
  kind: 'debits',
  tool: 'upcoming_payments',
  total: 2,
  route: '/finanzen/zahlungen',
  rows: [
    { mandate_id: 1, expected_date: '2026-10-10', overdue: true, counterparty: 'Muster Telekom', account_label: 'Girokonto', typical_amount: '-39.99' },
    { mandate_id: 2, expected_date: '2026-10-20', overdue: false, counterparty: 'Stadtwerke Musterstadt', account_label: 'Girokonto', typical_amount: '-84.00' },
  ],
}

export const DOCUMENTS_BLOCK: ResultBlock = {
  kind: 'documents',
  tool: 'search_documents',
  route: '/dokumente?q=Protokoll+Eigent%C3%BCmerversammlung&category=kapitalanlage-immobilie',
  rows: [
    { id: 101, title: 'Protokoll Eigentümerversammlung 2025', doc_date: '2025-06-12', from: 'Muster Hausverwaltung', category: 'kapitalanlage-immobilie' },
    { id: 87, title: 'Protokoll Eigentümerversammlung 2024', doc_date: '2024-06-20', from: 'Muster Hausverwaltung', category: 'kapitalanlage-immobilie' },
  ],
}

export const PHOTOS_BLOCK: ResultBlock = {
  kind: 'photos',
  tool: 'list_photos',
  total: 143,
  route: '/fotos/galerie?favorite=true&dateFrom=2025-01-01&dateTo=2025-12-31',
  rows: Array.from({ length: 16 }, (_, i) => ({ id: 1200 + i, filename: null, taken_at: `2025-0${(i % 9) + 1}-15T10:00:00Z` })),
}

export const RECAPS_BLOCK: ResultBlock = {
  kind: 'recaps',
  tool: 'list_recaps',
  route: '/fotos/rueckblicke',
  rows: [
    { id: 7, kind: 'trip', title: 'Sommer am Beispielsee', period_start: '2025-08-02', period_end: '2025-08-16', photo_count: 212, route: '/fotos/rueckblicke?id=7' },
    { id: 9, kind: 'trip', title: 'Herbst in Musterstadt', period_start: '2025-10-10', period_end: '2025-10-13', photo_count: 64, route: '/fotos/rueckblicke?id=9' },
  ],
}

export const ANALYSIS_BLOCK: ResultBlock = {
  kind: 'analysis',
  tool: 'analyze_spending',
  rows: [{
    question: 'Lebensmittel im September',
    sum: -412.37,
    count: 23,
    avg: -17.93,
    by_tag: [{ tag: 'Lebensmittel', sum: -380.1, count: 20 }, { tag: 'Drogerie', sum: -32.27, count: 3 }],
    by_period: [],
  }],
}

export const METERS_BLOCK: ResultBlock = {
  kind: 'meters',
  tool: 'list_meters',
  route: '/zaehler',
  rows: [
    { id: 3, name: 'Strom Haus', unit: 'kWh', last_value: 12345.6, last_read: '2026-10-01T00:00:00Z', route: '/zaehler/3' },
    { id: 4, name: 'Wasser Haus', unit: 'm³', last_value: null, last_read: null, route: '/zaehler/4' },
  ],
}

export const TABLE_BLOCK: ResultBlock = {
  kind: 'table',
  tool: 'list_persons',
  rows: [{ id: 1, name: 'Person A', faceCount: 120 }, { id: 2, name: 'Person B', faceCount: 48 }],
}

function proposal(status: 'pending' | 'executed' | 'discarded', extra: Record<string, unknown> = {}): ResultBlock {
  return {
    kind: 'proposal',
    tool: 'create_album',
    rows: [{
      proposal_id: status === 'pending' ? 1 : status === 'executed' ? 2 : 3,
      tool: 'create_album',
      summary: 'Album „Favoriten 2025“ anlegen und 143 Fotos hinzufügen',
      count: 143,
      status,
      result_summary: null,
      result_route: null,
      result_download: null,
      error: null,
      letter: null,
      ...extra,
    }],
  }
}

export const PROPOSAL_PENDING_BLOCK = proposal('pending')
export const PROPOSAL_EXECUTED_BLOCK = proposal('executed', {
  result_summary: 'Album „Favoriten 2025“ mit 143 Fotos angelegt',
  result_route: '/fotos/alben/12',
})
export const PROPOSAL_REPORT_BLOCK: ResultBlock = {
  kind: 'proposal',
  tool: 'transaction_report',
  rows: [{
    proposal_id: 4,
    tool: 'transaction_report',
    summary: 'Bericht „Wohnung Musterstadt“ als PDF: Kauf 3, Reparatur 2, Mieteinnahmen 12, Sonstige 1; 18 Buchungen, Summe −455.280,00 €, mit Rendite',
    count: 18,
    status: 'executed',
    result_summary: 'Bericht „Wohnung Musterstadt“ gespeichert – 18 Buchungen, Summe −455.280,00 €, Rendite = (10.800,00 € + −2.400,00 €) ÷ 463.680,00 € = 1,81 %',
    result_route: null,
    result_download: '/finance/reports/grouped/4/pdf',
    error: null,
  }],
}

const LETTER_BODY = [
  'Sehr geehrte Damen und Herren,',
  'hiermit bestätige ich, dass ich die folgenden Rechnungen am [[Zahlungsdatum]] bezahlt habe:',
  'RE-2026-0001 vom 02.03.2026 über 120,50 €\nRE-2026-0002 vom 09.03.2026 über 89,90 €\nRE-2026-0003 vom 16.03.2026 über 45,00 €',
  'Mit freundlichen Grüßen\nErika Beispiel',
].join('\n\n')

export const PROPOSAL_LETTER_BLOCK: ResultBlock = {
  kind: 'proposal',
  tool: 'render_letter',
  rows: [{
    proposal_id: 5,
    tool: 'render_letter',
    summary: 'Brief „Ihre Rechnungen RE-2026-0001 bis RE-2026-0003“ an Musterfirma Haustechnik GmbH, 3 Anlagen, 2 Lücken zum Ausfüllen',
    count: 3,
    status: 'pending',
    result_summary: null,
    result_route: null,
    result_download: null,
    error: null,
    letter: {
      sender: 'Erika Beispiel\n[[Ihre Anschrift]]',
      recipient: 'Musterfirma Haustechnik GmbH\nBeispielstraße 1\n12345 Musterstadt',
      subject: 'Ihre Rechnungen RE-2026-0001 bis RE-2026-0003',
      body: LETTER_BODY,
      attachments: [
        { id: 101, title: 'Rechnung Heizungswartung' },
        { id: 102, title: 'Rechnung Ersatzteil' },
        { id: 103, title: 'Rechnung Anfahrt' },
      ],
      destinations: ['document'],
      gaps: ['Ihre Anschrift', 'Zahlungsdatum'],
    },
  }],
}

export const PROPOSAL_DISCARDED_BLOCK = proposal('discarded')
export const PROPOSAL_FAILED_BLOCK = proposal('pending', { error: 'album name already in use' })

export const CONVERSATION: ConversationDetail = {
  id: 1,
  title: 'Strom und Lastschriften',
  created_at: '2026-10-15T09:00:00Z',
  updated_at: '2026-10-15T09:05:00Z',
  context: [],
  messages: [
    { id: 1, role: 'user', content: 'Welche Lastschriften muss ich in diesem Monat noch erwarten?', blocks: [], created_at: '2026-10-15T09:00:00Z' },
    {
      id: 4,
      role: 'assistant',
      content: 'Bis Ende Oktober kommen noch zwei Lastschriften, zusammen 123,99 €. Die von Muster Telekom ist seit dem 10. überfällig.',
      blocks: [DEBITS_BLOCK],
      created_at: '2026-10-15T09:00:20Z',
    },
    { id: 5, role: 'user', content: 'Zeig mir die Abschläge an die Stadtwerke in diesem Jahr.', blocks: [], created_at: '2026-10-15T09:04:00Z' },
    {
      id: 8,
      role: 'assistant',
      content: 'Ich habe 14 Buchungen an die Stadtwerke Musterstadt gefunden; die monatlichen Abschläge liegen bei 84,00 €.',
      blocks: [TRANSACTIONS_BLOCK],
      created_at: '2026-10-15T09:04:30Z',
    },
  ],
}
