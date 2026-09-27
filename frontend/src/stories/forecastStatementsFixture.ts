import type { ForecastItemStatements } from '../api/finance'

/** Standmitteilungen (#1343): one statement with a difference, one contract without a document. */
export const STATEMENTS: ForecastItemStatements[] = [
  {
    itemId: 106,
    contractNo: 'X-000111',
    links: [
      { id: 1, documentId: 501, title: 'Standmitteilung 2026', docDate: '2026-02-10', documentType: 'standmitteilung', matchKind: 'tag', status: 'confirmed', kind: 'statement', kindByUser: false },
      { id: 2, documentId: 502, title: 'Jahresinformation', docDate: '2025-02-12', documentType: 'standmitteilung', matchKind: 'text', status: 'suggested', kind: 'statement', kindByUser: false },
    ],
    latest: {
      id: 31,
      documentId: 501,
      referenceDate: '2026-01-01',
      values: {
        referenceDate: '2026-01-01',
        surrenderValue: 39150,
        contractValue: null,
        guaranteedPayout: 55000,
        projectedPayout: 60400,
        premiumMonthly: 150,
        premiumYearly: null,
        premiumEndDate: null,
        maturityDate: '2032-12-01',
        guaranteedMonthlyPension: null,
        projectedMonthlyPension: null,
        lumpSum: null,
        pensionStartDate: null,
      },
      method: 'regex',
      status: 'proposed',
      extractedAt: '2026-02-11T08:00:00Z',
    },
    proposals: [
      { field: 'surrenderValue', label: 'Rückkaufswert', kind: 'amount', current: 38000, proposed: 39150 },
      { field: 'projectedPayout', label: 'Prognostizierte Ablaufleistung', kind: 'amount', current: 62000, proposed: 60400 },
    ],
    history: [],
    valuesSource: { kind: 'import', updatedAt: '2026-09-20T10:00:00Z' },
    overdue: false,
    reading: false,
    notes: [],
    declinedWithoutDocument: [],
  },
  {
    itemId: 112,
    contractNo: 'K-000222',
    links: [],
    latest: null,
    proposals: [],
    history: [],
    valuesSource: { kind: 'manual', updatedAt: '2026-08-01T10:00:00Z' },
    overdue: false,
    reading: false,
    notes: [],
    declinedWithoutDocument: [],
  },
]
