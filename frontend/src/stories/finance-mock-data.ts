import type { Account, Bankcontact, OverviewResponse, Tag, Transaction } from '../api/finance'

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
