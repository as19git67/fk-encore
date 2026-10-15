/**
 * Synthetic data for the assistant's stories (#1528): blocks of every kind
 * as the server sends them. Names, places and numbers are made up.
 */
import type { ConversationDetail, ResultBlock } from '../api/assistant'

export const TRANSACTIONS_BLOCK: ResultBlock = {
  kind: 'transactions',
  tool: 'list_transactions',
  total: 14,
  route: '/finanzen/uebersicht/konto/1?q=Stadtwerke&dateFrom=2026-01-01&dateTo=2026-09-30',
  rows: [
    { id: 501, booking_date: '2026-09-20', amount: '-84.00', counterparty: 'Stadtwerke Musterstadt', purpose: 'Abschlag Strom September' },
    { id: 502, booking_date: '2026-08-20', amount: '-84.00', counterparty: 'Stadtwerke Musterstadt', purpose: 'Abschlag Strom August' },
    { id: 503, booking_date: '2026-07-31', amount: '112.40', counterparty: 'Stadtwerke Musterstadt', purpose: 'Erstattung aus der Jahresabrechnung mit einem recht langen Verwendungszweck' },
  ],
}

export const DEBITS_BLOCK: ResultBlock = {
  kind: 'debits',
  tool: 'upcoming_direct_debits',
  total: 2,
  route: '/finanzen/lastschriften',
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

export const CONVERSATION: ConversationDetail = {
  id: 1,
  title: 'Strom und Lastschriften',
  created_at: '2026-10-15T09:00:00Z',
  updated_at: '2026-10-15T09:05:00Z',
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
