import type { Account, AnomalyItem, Bankcontact, OverviewResponse, PortfolioPositionResponse, PortfolioResponse, PortfolioReviewResponse, PortfolioTransaction, Tag, Transaction } from '../api/finance'

/**
 * Fixtures for the finance stories (issue #1281).
 *
 * Everything here is invented: the repo keeps no personal data, so an IBAN
 * is `DE00 …`, a counterparty is a shop that does not exist, and an amount
 * is a round number nobody could recognise.
 */

export const MOCK_ACCOUNTS: Account[] = [
  {
    id: 1,
    bankcontact_id: 1,
    bankcontact_name: 'Beispielbank',
    fints_account_number: '1000000000',
    type_kind: 'giro',
    type_label: 'Girokonto',
    currency_code: 'EUR',
    currency_symbol: '€',
    iban: 'DE00000000001000000000',
    account_number: '1000000000',
    label: 'Girokonto',
    closed_at: null,
    created_at: '2024-01-01T00:00:00.000Z',
    access_count: 2,
  },
  {
    id: 2,
    bankcontact_id: null,
    bankcontact_name: null,
    fints_account_number: null,
    type_kind: 'cash',
    type_label: 'Bargeld',
    currency_code: 'EUR',
    currency_symbol: '€',
    iban: null,
    account_number: 'bar-1',
    label: 'Haushaltskasse',
    closed_at: null,
    created_at: '2024-01-01T00:00:00.000Z',
    access_count: 1,
  },
]

export const MOCK_FINANCE_TAGS: Tag[] = [
  { id: 1, name: 'Lebensmittel', source: 'user', created_at: '2024-02-01T00:00:00.000Z' },
  { id: 2, name: 'Strom', source: 'user', created_at: '2024-02-01T00:00:00.000Z' },
  { id: 3, name: 'Versicherung', source: 'ai', created_at: '2024-02-01T00:00:00.000Z' },
]

/**
 * The fields every booking has; a story overrides only what it cares about.
 * The return type is `Transaction` with no cast on purpose — a cast here
 * would hide a field the view reads, which is exactly how a first version of
 * these fixtures shipped without `tags` and every story crashed on
 * `tx.tags.length`.
 */
function transaction(overrides: Partial<Transaction> & Pick<Transaction, 'id' | 'amount'>): Transaction {
  return {
    account_id: 1,
    booking_date: '2026-03-02',
    value_date: '2026-03-02',
    currency_code: 'EUR',
    purpose: null,
    counterparty: null,
    counterparty_iban: null,
    counterparty_bic: null,
    end_to_end_ref: null,
    mandate_ref: null,
    creditor_id: null,
    bank_ref: null,
    originator_name: null,
    recipient_name: null,
    funds_code: null,
    transaction_type: null,
    transaction_code: null,
    entry_text: null,
    prima_nota_no: null,
    original_amount: null,
    original_currency_code: null,
    exchange_rate: null,
    notice: null,
    reviewed_at: null,
    is_tax_relevant: false,
    has_tax_relevant_split: false,
    tags: [],
    created_at: '2026-03-02T06:00:00.000Z',
    ...overrides,
  }
}

export const MOCK_TRANSACTIONS: Transaction[] = [
  transaction({
    id: 101,
    amount: '-42.50',
    booking_date: '2026-03-02',
    counterparty: 'Supermarkt Musterstadt',
    purpose: 'Wocheneinkauf',
    entry_text: 'Kartenzahlung',
    tags: [{ name: 'Lebensmittel', source: 'user', confidence: null }],
  }),
  transaction({
    id: 102,
    amount: '-118.00',
    booking_date: '2026-03-01',
    counterparty: 'Stadtwerke Musterstadt',
    purpose: 'Abschlag Strom März',
    tags: [
      { name: 'Strom', source: 'user', confidence: null },
      { name: 'Versicherung', source: 'ai', confidence: 0.72 },
    ],
    is_tax_relevant: true,
    reviewed_at: '2026-03-01T10:00:00.000Z',
  }),
  transaction({
    id: 103,
    amount: '2450.00',
    booking_date: '2026-02-28',
    counterparty: 'Musterfirma GmbH',
    purpose: 'Gehalt Februar',
    entry_text: 'Überweisung',
  }),
  transaction({
    id: 104,
    amount: '-9.99',
    booking_date: '2026-02-27',
    counterparty: 'Beispiel-Abo',
    purpose: 'Monatsbeitrag',
    notice: 'Kündigen prüfen',
  }),
]

export const MOCK_OVERVIEW: OverviewResponse = {
  user_email: 'nutzer@beispiel.test',
  is_default: false,
  sections: [
    {
      name: 'Alltag',
      accounts: [
        {
          id: 1,
          label: 'Girokonto',
          type_kind: 'giro',
          type_label: 'Girokonto',
          currency_code: 'EUR',
          currency_symbol: '€',
          balance: '3250.75',
          balance_as_of: '2026-03-02T06:00:00.000Z',
          pending_count: 2,
          sync_attention: 'tan-required',
          bankcontact_id: 1,
          bankcontact_name: 'Musterbank',
        },
        {
          id: 2,
          label: 'Haushaltskasse',
          type_kind: 'cash',
          type_label: 'Bargeld',
          currency_code: 'EUR',
          currency_symbol: '€',
          balance: '120.00',
          balance_as_of: '2026-03-01T06:00:00.000Z',
          pending_count: 0,
          sync_attention: null,
          bankcontact_id: null,
          bankcontact_name: null,
        },
      ],
    },
  ],
  unassigned: [],
}

export const MOCK_BANKCONTACTS: Bankcontact[] = [
  {
    id: 1,
    name: 'Beispielbank',
    blz: '00000000',
    login: 'beispiel-login',
    server_url: 'https://fints.beispiel.test/',
    tan_method: '942',
    credentials_set: true,
    last_sync_at: '2026-03-02T05:30:00.000Z',
    last_sync_status: 'ok',
    created_at: '2024-01-01T00:00:00.000Z',
    available_tan_methods: [{ id: 942, name: 'Beispiel-TAN (Push)', isDecoupled: true }],
    sync_times: [{ weekdays: [1, 3, 5], time: '06:00', tz: 'Europe/Berlin' }],
  },
  {
    id: 2,
    name: 'Zweitbank',
    blz: '00000001',
    login: 'zweit-login',
    server_url: 'https://fints.zweitbank.test/',
    tan_method: null,
    credentials_set: false,
    last_sync_at: null,
    last_sync_status: null,
    created_at: '2025-06-01T00:00:00.000Z',
    available_tan_methods: [],
    sync_times: [],
  },
]

/**
 * Anomalies as the detector reports them — one of each kind the list draws
 * differently: a standing order that got dearer, a duplicate booking, a
 * mandate seen for the first time, and one that failed to show up at all.
 */
export const MOCK_ANOMALIES: AnomalyItem[] = [
  {
    id: 1,
    type: 'amount_change',
    score: 0.92,
    details: { previous_amount: '-48.90', current_amount: '-79.90' },
    created_at: '2025-06-10T06:00:00.000Z',
    transaction_id: 1,
    mandate_id: 11,
    counterparty: 'Beispiel Energie GmbH',
    message: 'Der Betrag ist von 48,90 € auf 79,90 € gestiegen.',
  },
  {
    id: 2,
    type: 'duplicate',
    score: 0.81,
    details: {},
    created_at: '2025-06-09T06:00:00.000Z',
    transaction_id: 2,
    mandate_id: null,
    counterparty: 'Musterladen KG',
    message: 'Zwei Buchungen am selben Tag über denselben Betrag.',
    duplicate_transactions: [
      { id: 2, booking_date: '2025-06-08', amount: '-24.99', purpose: 'Einkauf' },
      { id: 3, booking_date: '2025-06-08', amount: '-24.99', purpose: 'Einkauf' },
    ],
  },
  {
    id: 3,
    type: 'new_mandate',
    score: 0.5,
    details: {},
    created_at: '2025-06-08T06:00:00.000Z',
    transaction_id: 4,
    mandate_id: 12,
    counterparty: 'Beispiel Streaming BV',
    message: 'Ein neues Lastschriftmandat wurde zum ersten Mal eingelöst.',
  },
  {
    id: 4,
    type: 'missing_transaction',
    score: 0.74,
    details: { expected_on: '2025-06-01' },
    created_at: '2025-06-07T06:00:00.000Z',
    transaction_id: null,
    mandate_id: 13,
    counterparty: 'Beispiel Versicherung AG',
    message: 'Die monatliche Buchung ist im Juni ausgeblieben.',
  },
]

// ── Portfolio (issue #1336) ─────────────────────────────────────────────
// Two invented securities in two invented depots; ISINs with a made-up
// national part so they could never match a real paper.

const PF_ISIN_A = 'DE0000000AAA1'
const PF_ISIN_B = 'DE0000000BBB2'

export const MOCK_PORTFOLIO: PortfolioResponse = {
  accounts: [
    { id: 11, label: 'Depot Beispielbank', currency_code: 'EUR' },
    { id: 12, label: 'Depot Musterbroker', currency_code: 'EUR' },
  ],
  currency: 'EUR',
  mixed_currency: false,
  summary: {
    as_of: '2026-09-30',
    market_value: '14250.00',
    cost_basis: '12000.00',
    cost_basis_complete: true,
    unrealized_gain: '2250.00',
    unrealized_gain_pct: '18.75',
    realized_gain: '310.00',
    realized_gain_ytd: '190.00',
    realized_gain_complete: true,
    income: '242.50',
    income_ytd: '122.50',
    fees: '47.00',
    taxes: '68.20',
    total_return: '2802.50',
    total_return_pct: '23.35',
    open_positions: 2,
    closed_positions: 1,
    transaction_count: 9,
  },
  positions: [
    {
      key: PF_ISIN_A,
      isin: PF_ISIN_A,
      wkn: 'AAA111',
      name: 'Alpha Industries AG',
      currency: 'EUR',
      account_ids: [11, 12],
      open: true,
      amount: '60.00000000',
      price: '150.000000',
      price_as_of: '2026-09-30',
      value: '9000.00',
      cost_basis: '7200.00',
      cost_basis_per_unit: '120.000000',
      cost_basis_source: 'bank',
      unrealized_gain: '1800.00',
      unrealized_gain_pct: '25.00',
      weight_pct: '63.16',
      realized_gain: '190.00',
      realized_gain_complete: true,
      income: '180.00',
      yield_on_cost_pct: '2.50',
      fees: '30.00',
      taxes: '52.70',
      total_return: '2170.00',
      total_return_pct: '30.14',
      buy_count: 3,
      sell_count: 1,
      dividend_count: 2,
      first_transaction_at: '2024-02-15',
      last_transaction_at: '2026-05-12',
    },
    {
      key: PF_ISIN_B,
      isin: PF_ISIN_B,
      wkn: null,
      name: 'Beispiel World ETF',
      currency: 'EUR',
      account_ids: [12],
      open: true,
      amount: '100.00000000',
      price: '52.500000',
      price_as_of: '2026-09-29',
      value: '5250.00',
      cost_basis: '4800.00',
      cost_basis_per_unit: '48.000000',
      cost_basis_source: 'tx-wac',
      unrealized_gain: '450.00',
      unrealized_gain_pct: '9.38',
      weight_pct: '36.84',
      realized_gain: null,
      realized_gain_complete: true,
      income: '62.50',
      yield_on_cost_pct: '1.30',
      fees: '12.00',
      taxes: '15.50',
      total_return: '512.50',
      total_return_pct: '10.68',
      buy_count: 2,
      sell_count: 0,
      dividend_count: 1,
      first_transaction_at: '2025-01-10',
      last_transaction_at: '2026-04-20',
    },
    {
      key: 'Gamma Beteiligungen',
      isin: null,
      wkn: null,
      name: 'Gamma Beteiligungen',
      currency: 'EUR',
      account_ids: [11],
      open: false,
      amount: null,
      price: null,
      price_as_of: null,
      value: null,
      cost_basis: null,
      cost_basis_per_unit: null,
      cost_basis_source: null,
      unrealized_gain: null,
      unrealized_gain_pct: null,
      weight_pct: null,
      realized_gain: '120.00',
      realized_gain_complete: false,
      income: null,
      yield_on_cost_pct: null,
      fees: '5.00',
      taxes: null,
      total_return: '120.00',
      total_return_pct: null,
      buy_count: 1,
      sell_count: 1,
      dividend_count: 0,
      first_transaction_at: '2024-06-01',
      last_transaction_at: '2025-03-01',
    },
  ],
  years: [
    { year: 2026, realized: '190.00', sell_count: 1, realized_complete: true, income: '122.50', dividend_count: 2, fees: '10.00', taxes: '38.20', net_invested: '-1710.00' },
    { year: 2025, realized: '120.00', sell_count: 1, realized_complete: false, income: '120.00', dividend_count: 1, fees: '17.00', taxes: '30.00', net_invested: '2900.00' },
    { year: 2024, realized: '0.00', sell_count: 0, realized_complete: true, income: '0.00', dividend_count: 0, fees: '20.00', taxes: '0.00', net_invested: '6000.00' },
  ],
}

export const MOCK_PORTFOLIO_EMPTY: PortfolioResponse = {
  accounts: [],
  currency: 'EUR',
  mixed_currency: false,
  summary: {
    as_of: null,
    market_value: '0.00',
    cost_basis: '0.00',
    cost_basis_complete: true,
    unrealized_gain: '0.00',
    unrealized_gain_pct: null,
    realized_gain: '0.00',
    realized_gain_ytd: '0.00',
    realized_gain_complete: true,
    income: '0.00',
    income_ytd: '0.00',
    fees: '0.00',
    taxes: '0.00',
    total_return: '0.00',
    total_return_pct: null,
    open_positions: 0,
    closed_positions: 0,
    transaction_count: 0,
  },
  positions: [],
  years: [],
}

function portfolioTx(
  overrides: Partial<PortfolioTransaction> & Pick<PortfolioTransaction, 'id' | 'kind' | 'executed_at'>,
): PortfolioTransaction {
  return {
    account_id: 11,
    account_label: 'Depot Beispielbank',
    position_key: PF_ISIN_A,
    isin: PF_ISIN_A,
    wkn: 'AAA111',
    name: 'Alpha Industries AG',
    amount: null,
    price: null,
    gross_amount: null,
    fees: null,
    tax: null,
    net_amount: null,
    currency: 'EUR',
    source: 'manual',
    linked_transaction_id: null,
    note: null,
    document_ids: [],
    ...overrides,
  }
}

export const MOCK_PORTFOLIO_TRANSACTIONS: PortfolioTransaction[] = [
  portfolioTx({ id: 901, kind: 'dividend', executed_at: '2026-05-12', gross_amount: '120.00', tax: '31.65', net_amount: '88.35', source: 'giro-derived+document', linked_transaction_id: 4711, document_ids: [301] }),
  portfolioTx({ id: 902, kind: 'dividend', executed_at: '2026-04-20', account_id: 12, account_label: 'Depot Musterbroker', position_key: PF_ISIN_B, isin: PF_ISIN_B, wkn: null, name: 'Beispiel World ETF', gross_amount: '78.00', tax: '15.50', net_amount: '62.50' }),
  portfolioTx({ id: 903, kind: 'sell', executed_at: '2026-02-03', amount: '10', price: '145.00', gross_amount: '1450.00', fees: '10.00', tax: '21.05', net_amount: '1418.95', source: 'document', document_ids: [302] }),
  portfolioTx({ id: 904, kind: 'buy', executed_at: '2025-11-05', account_id: 12, account_label: 'Depot Musterbroker', position_key: PF_ISIN_B, isin: PF_ISIN_B, wkn: null, name: 'Beispiel World ETF', amount: '50', price: '49.00', gross_amount: '2450.00', fees: '7.00', net_amount: '-2457.00' }),
  portfolioTx({ id: 905, kind: 'dividend', executed_at: '2025-05-14', gross_amount: '150.00', tax: '30.00', net_amount: '120.00' }),
  portfolioTx({ id: 906, kind: 'sell', executed_at: '2025-03-01', position_key: 'Gamma Beteiligungen', isin: null, wkn: null, name: 'Gamma Beteiligungen', amount: '20', net_amount: '620.00', fees: '5.00' }),
  portfolioTx({ id: 907, kind: 'buy', executed_at: '2025-01-10', account_id: 12, account_label: 'Depot Musterbroker', position_key: PF_ISIN_B, isin: PF_ISIN_B, wkn: null, name: 'Beispiel World ETF', amount: '50', price: '47.00', gross_amount: '2350.00', fees: '5.00', net_amount: '-2355.00' }),
  portfolioTx({ id: 908, kind: 'buy', executed_at: '2024-06-01', position_key: 'Gamma Beteiligungen', isin: null, wkn: null, name: 'Gamma Beteiligungen', amount: '20', net_amount: '-500.00' }),
  portfolioTx({ id: 909, kind: 'buy', executed_at: '2024-02-15', amount: '70', price: '120.00', gross_amount: '8400.00', fees: '20.00', net_amount: '-8420.00', source: 'fints-mt536' }),
]

export const MOCK_PORTFOLIO_POSITION: PortfolioPositionResponse = {
  currency: 'EUR',
  position: MOCK_PORTFOLIO.positions[0]!,
  accounts: [
    { account_id: 11, account_label: 'Depot Beispielbank', amount: '40.00000000', value: '6000.00', cost_basis: '4800.00', cost_basis_source: 'bank', as_of: '2026-09-30' },
    { account_id: 12, account_label: 'Depot Musterbroker', amount: '20.00000000', value: '3000.00', cost_basis: '2400.00', cost_basis_source: 'tx-wac', as_of: '2026-09-30' },
  ],
  history: ([
    ['2024-03-01', '70', '118.000000', '8260.00'],
    ['2024-06-01', '70', '124.500000', '8715.00'],
    ['2024-09-01', '70', '121.000000', '8470.00'],
    ['2024-12-01', '70', '131.000000', '9170.00'],
    ['2025-03-01', '70', '128.000000', '8960.00'],
    ['2025-06-01', '70', '136.000000', '9520.00'],
    ['2025-09-01', '70', '141.500000', '9905.00'],
    ['2025-12-01', '70', '139.000000', '9730.00'],
    ['2026-03-01', '60', '146.000000', '8760.00'],
    ['2026-06-01', '60', '143.000000', '8580.00'],
    ['2026-09-30', '60', '150.000000', '9000.00'],
  ] as Array<[string, string, string, string]>).map(([as_of, amount, price, value]) => ({ as_of, amount, price, value })),
  transactions: MOCK_PORTFOLIO_TRANSACTIONS.filter((t) => t.position_key === PF_ISIN_A),
  sales: [
    { transaction_id: 903, account_id: 11, executed_at: '2026-02-03', quantity: '10.00000000', proceeds: '1418.95', cost: '1200.00', cost_per_unit: '120.000000', gain: '218.95' },
  ],
  holding_gaps: [
    { account_id: 12, position_key: PF_ISIN_A, from: '2025-06-01', to: '2025-09-01', amount_before: '10.00000000', amount_after: '20.00000000', delta: '10.00000000', explained: '0.00000000', unexplained: '10.00000000', transaction_count: 0 },
  ],
  unverifiable_changes: 1,
  years: [
    { year: 2026, realized: '218.95', sell_count: 1, income: '88.35', dividend_count: 1, fees: '10.00', taxes: '52.70', },
    { year: 2025, realized: '0.00', sell_count: 0, income: '120.00', dividend_count: 1, fees: '0.00', taxes: '30.00' },
    { year: 2024, realized: '0.00', sell_count: 0, income: '0.00', dividend_count: 0, fees: '20.00', taxes: '0.00' },
  ],
}

export const MOCK_PORTFOLIO_REVIEW: PortfolioReviewResponse = {
  conflicts: [
    {
      document_id: 305,
      document_title: 'Wertpapierabrechnung Kauf Beispiel World ETF',
      account_id: 12,
      account_label: 'Depot Musterbroker',
      depot_transaction_id: 904,
      position_key: PF_ISIN_B,
      name: 'Beispiel World ETF',
      kind: 'buy',
      executed_at: '2025-11-05',
      statement_net: '-2459.50',
      transaction_net: '-2457.00',
    },
  ],
  unmatched_documents: [
    { document_id: 306, document_title: 'Dividendengutschrift Gamma Beteiligungen', doc_date: '2026-06-15', isin: 'DE000000GGG7', wkn: null, depot_number: '9900000001' },
  ],
  holding_gaps: [
    {
      account_id: 12, account_label: 'Depot Musterbroker', position_key: PF_ISIN_A, name: 'Alpha Industries AG',
      from: '2025-06-01', to: '2025-09-01', amount_before: '10.00000000', amount_after: '20.00000000',
      delta: '10.00000000', explained: '0.00000000', unexplained: '10.00000000', transaction_count: 0,
    },
  ],
  unverifiable_changes: 2,
}

export const MOCK_PORTFOLIO_REVIEW_EMPTY: PortfolioReviewResponse = {
  conflicts: [],
  unmatched_documents: [],
  holding_gaps: [],
  unverifiable_changes: 0,
}
