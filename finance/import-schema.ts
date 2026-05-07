/**
 * Validation for the Finanzkraft JSON export format.
 *
 * The actual Finanzkraft app emits a free-form JSON; this module
 * defines the canonical shape the importer expects. It is the
 * contract between whoever prepares the export file (the admin,
 * manually, or a one-off migration script) and `data-import.ts`.
 *
 * Deliberately minimal — every field that isn't relevant for the
 * non-user-specific import scope (see finance-data-import.md §2) is
 * dropped here so we can't accidentally carry credentials, ACL rows
 * or transaction-status through.
 */

console.log("[boot] finance/import-schema.ts: all imports resolved");

// -----------------------------------------------------------------------
// Shape
// -----------------------------------------------------------------------

export interface ImportBankcontact {
  /** Natural key — (blz, login) is globally unique per bankcontact. */
  blz: string;
  login: string;
  name: string;
  server_url: string;
  tan_method?: string | null;
}

export interface ImportAccount {
  /**
   * Parent bankcontact lookup keys. Both null/missing → manual account
   * (no bankcontact_id). Mixing one set / one null is a validation error
   * because it suggests the export is malformed.
   */
  bankcontact_blz?: string | null;
  bankcontact_login?: string | null;
  type_kind: string; // e.g. "giro" — validated against the enum
  currency_code: string; // e.g. "EUR"
  /** Optional, primary natural key for dedupe when present. */
  iban?: string | null;
  /** Required even if iban is set — falls back as dedupe key when iban is null. */
  account_number: string;
  label: string;
  active?: boolean;
  /** lib-fints accountNumber for the bank-side account, when known.
   *  Pre-fills `finance_account.fints_account_number` so a sync works
   *  the moment the user wires up real credentials on the bankcontact. */
  fints_account_number?: string | null;
}

export interface ImportTransaction {
  /** Parent account lookup via iban OR (bankcontact + account_number). */
  account_iban?: string | null;
  account_bankcontact_blz?: string | null;
  account_bankcontact_login?: string | null;
  account_number?: string | null;
  booking_date: string; // YYYY-MM-DD
  value_date?: string | null;
  /** Signed amount as a string to avoid float drift; converted to numeric(12,2). */
  amount: string;
  currency_code: string;
  purpose?: string | null;
  notice?: string | null;
  counterparty?: string | null;
  counterparty_iban?: string | null;
  counterparty_bic?: string | null;
  counterparty_bank_id?: string | null;
  /** SEPA / MT940 fields — match the columns added in migration 0055. */
  end_to_end_ref?: string | null;
  mandate_ref?: string | null;
  creditor_id?: string | null;
  bank_ref?: string | null;
  originator_name?: string | null;
  recipient_name?: string | null;
  funds_code?: string | null;
  transaction_type?: string | null;
  transaction_code?: string | null;
  entry_text?: string | null;
  prima_nota_no?: string | null;
  /** Multi-currency booking metadata. All three together or none. */
  original_amount?: string | null;
  original_currency_code?: string | null;
  exchange_rate?: string | null;
  /** Optional pre-computed dedupe hash; if missing the importer recomputes. */
  dedupe_hash?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface ImportTagLink {
  /** Tag name — always imported as source='user'. */
  tag: string;
  /**
   * Composite key to locate the parent transaction:
   * `account_iban` (or `account_number` for cash wallets) + `booking_date`
   * + `dedupe_hash`. The exporter must compute the same dedupe hash the
   * transaction row carries — see `computeDedupeHash` in data-import.ts.
   */
  account_iban?: string | null;
  account_bankcontact_blz?: string | null;
  account_bankcontact_login?: string | null;
  account_number?: string | null;
  booking_date?: string | null;
  dedupe_hash?: string | null;
}

export interface ImportCurrency {
  /** ISO-4217 currency code (3 letters, will be uppercased on insert). */
  code: string;
  /** Display symbol — €, $, £, … Falls back to `code` when missing. */
  symbol?: string | null;
  /** Number of decimal places. Default 2. */
  decimals?: number | null;
}

export interface FinanzkraftExport {
  version: string;
  /**
   * Currencies to upsert into `finance_currency` before any other stage
   * runs. Lets the import bring in transactions denominated in
   * currencies the database doesn't yet seed (CHF, GBP, …) without
   * needing a manual migration. Optional — fk-encore ships with EUR
   * and USD pre-seeded; add only what's missing.
   */
  currencies?: ImportCurrency[];
  bankcontacts: ImportBankcontact[];
  accounts: ImportAccount[];
  transactions: ImportTransaction[];
  tags: string[];
  tag_links: ImportTagLink[];
}

// -----------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------

export class ImportSchemaError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ImportSchemaError";
  }
}

function assertString(v: unknown, path: string): string {
  if (typeof v !== "string") {
    throw new ImportSchemaError(path, "expected a string");
  }
  return v;
}

function assertNonEmptyString(v: unknown, path: string): string {
  const s = assertString(v, path);
  if (s.length === 0) {
    throw new ImportSchemaError(path, "must not be empty");
  }
  return s;
}

function assertArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new ImportSchemaError(path, "expected an array");
  }
  return v;
}

function assertObject(v: unknown, path: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ImportSchemaError(path, "expected an object");
  }
  return v as Record<string, unknown>;
}

function optString(
  v: unknown,
  path: string,
): string | undefined {
  if (v === undefined || v === null) return undefined;
  return assertString(v, path);
}

function validateBankcontact(raw: unknown, i: number): ImportBankcontact {
  const o = assertObject(raw, `bankcontacts[${i}]`);
  return {
    blz: assertNonEmptyString(o.blz, `bankcontacts[${i}].blz`),
    login: assertNonEmptyString(o.login, `bankcontacts[${i}].login`),
    name: assertNonEmptyString(o.name, `bankcontacts[${i}].name`),
    server_url: assertNonEmptyString(
      o.server_url,
      `bankcontacts[${i}].server_url`,
    ),
    tan_method: optString(o.tan_method, `bankcontacts[${i}].tan_method`),
  };
}

function validateAccount(raw: unknown, i: number): ImportAccount {
  const o = assertObject(raw, `accounts[${i}]`);
  // bankcontact_blz/login: both present (linked) or both absent (manual);
  // mixing the two is a malformed-export signal we surface immediately.
  const blz = optString(o.bankcontact_blz, `accounts[${i}].bankcontact_blz`) ?? null;
  const login = optString(o.bankcontact_login, `accounts[${i}].bankcontact_login`) ?? null;
  if ((blz === null) !== (login === null)) {
    throw new ImportSchemaError(
      `accounts[${i}]`,
      "bankcontact_blz and bankcontact_login must be both set or both omitted",
    );
  }
  return {
    bankcontact_blz: blz,
    bankcontact_login: login,
    type_kind: assertNonEmptyString(o.type_kind, `accounts[${i}].type_kind`),
    currency_code: assertNonEmptyString(
      o.currency_code,
      `accounts[${i}].currency_code`,
    ),
    iban: optString(o.iban, `accounts[${i}].iban`) ?? null,
    account_number: assertNonEmptyString(
      o.account_number,
      `accounts[${i}].account_number`,
    ),
    label: assertNonEmptyString(o.label, `accounts[${i}].label`),
    active: typeof o.active === "boolean" ? o.active : undefined,
    fints_account_number: optString(
      o.fints_account_number,
      `accounts[${i}].fints_account_number`,
    ),
  };
}

function validateTransaction(raw: unknown, i: number): ImportTransaction {
  const o = assertObject(raw, `transactions[${i}]`);
  const bookingDate = assertNonEmptyString(
    o.booking_date,
    `transactions[${i}].booking_date`,
  );
  if (!/^\d{4}-\d{2}-\d{2}/.test(bookingDate)) {
    throw new ImportSchemaError(
      `transactions[${i}].booking_date`,
      "expected YYYY-MM-DD",
    );
  }
  return {
    account_iban: optString(o.account_iban, `transactions[${i}].account_iban`),
    account_bankcontact_blz: optString(
      o.account_bankcontact_blz,
      `transactions[${i}].account_bankcontact_blz`,
    ),
    account_bankcontact_login: optString(
      o.account_bankcontact_login,
      `transactions[${i}].account_bankcontact_login`,
    ),
    account_number: optString(
      o.account_number,
      `transactions[${i}].account_number`,
    ),
    booking_date: bookingDate,
    value_date: optString(o.value_date, `transactions[${i}].value_date`),
    amount: assertNonEmptyString(o.amount, `transactions[${i}].amount`),
    currency_code: assertNonEmptyString(
      o.currency_code,
      `transactions[${i}].currency_code`,
    ),
    purpose: optString(o.purpose, `transactions[${i}].purpose`),
    notice: optString(o.notice, `transactions[${i}].notice`),
    counterparty: optString(
      o.counterparty,
      `transactions[${i}].counterparty`,
    ),
    counterparty_iban: optString(
      o.counterparty_iban,
      `transactions[${i}].counterparty_iban`,
    ),
    counterparty_bic: optString(
      o.counterparty_bic,
      `transactions[${i}].counterparty_bic`,
    ),
    counterparty_bank_id: optString(
      o.counterparty_bank_id,
      `transactions[${i}].counterparty_bank_id`,
    ),
    end_to_end_ref: optString(
      o.end_to_end_ref,
      `transactions[${i}].end_to_end_ref`,
    ),
    mandate_ref: optString(o.mandate_ref, `transactions[${i}].mandate_ref`),
    creditor_id: optString(o.creditor_id, `transactions[${i}].creditor_id`),
    bank_ref: optString(o.bank_ref, `transactions[${i}].bank_ref`),
    originator_name: optString(
      o.originator_name,
      `transactions[${i}].originator_name`,
    ),
    recipient_name: optString(
      o.recipient_name,
      `transactions[${i}].recipient_name`,
    ),
    funds_code: optString(o.funds_code, `transactions[${i}].funds_code`),
    transaction_type: optString(o.transaction_type, `transactions[${i}].transaction_type`),
    transaction_code: optString(o.transaction_code, `transactions[${i}].transaction_code`),
    entry_text: optString(o.entry_text, `transactions[${i}].entry_text`),
    prima_nota_no: optString(
      o.prima_nota_no,
      `transactions[${i}].prima_nota_no`,
    ),
    original_amount: optString(
      o.original_amount,
      `transactions[${i}].original_amount`,
    ),
    original_currency_code: optString(
      o.original_currency_code,
      `transactions[${i}].original_currency_code`,
    ),
    exchange_rate: optString(
      o.exchange_rate,
      `transactions[${i}].exchange_rate`,
    ),
    dedupe_hash: optString(o.dedupe_hash, `transactions[${i}].dedupe_hash`),
    raw:
      o.raw && typeof o.raw === "object" && !Array.isArray(o.raw)
        ? (o.raw as Record<string, unknown>)
        : null,
  };
}

function validateTagLink(raw: unknown, i: number): ImportTagLink {
  const o = assertObject(raw, `tag_links[${i}]`);
  return {
    tag: assertNonEmptyString(o.tag, `tag_links[${i}].tag`),
    account_iban: optString(o.account_iban, `tag_links[${i}].account_iban`),
    account_bankcontact_blz: optString(
      o.account_bankcontact_blz,
      `tag_links[${i}].account_bankcontact_blz`,
    ),
    account_bankcontact_login: optString(
      o.account_bankcontact_login,
      `tag_links[${i}].account_bankcontact_login`,
    ),
    account_number: optString(
      o.account_number,
      `tag_links[${i}].account_number`,
    ),
    booking_date: optString(o.booking_date, `tag_links[${i}].booking_date`),
    dedupe_hash: optString(o.dedupe_hash, `tag_links[${i}].dedupe_hash`),
  };
}

function validateCurrency(raw: unknown, i: number): ImportCurrency {
  const o = assertObject(raw, `currencies[${i}]`);
  const code = assertNonEmptyString(o.code, `currencies[${i}].code`);
  if (code.length !== 3 || !/^[A-Za-z]{3}$/.test(code)) {
    throw new ImportSchemaError(
      `currencies[${i}].code`,
      `expected a 3-letter ISO-4217 code, got "${code}"`,
    );
  }
  let decimals: number | null = null;
  if (o.decimals !== undefined && o.decimals !== null) {
    if (typeof o.decimals !== "number" || !Number.isInteger(o.decimals)) {
      throw new ImportSchemaError(
        `currencies[${i}].decimals`,
        "expected an integer",
      );
    }
    decimals = o.decimals;
  }
  return {
    code,
    symbol: optString(o.symbol, `currencies[${i}].symbol`) ?? null,
    decimals,
  };
}

export function validateExport(raw: unknown): FinanzkraftExport {
  const o = assertObject(raw, "root");
  const version = assertNonEmptyString(o.version, "version");
  const currencies =
    o.currencies === undefined
      ? undefined
      : assertArray(o.currencies, "currencies").map(validateCurrency);
  const bankcontacts = assertArray(o.bankcontacts, "bankcontacts").map(
    validateBankcontact,
  );
  const accounts = assertArray(o.accounts, "accounts").map(validateAccount);
  const transactions = assertArray(o.transactions, "transactions").map(
    validateTransaction,
  );
  const tags = assertArray(o.tags, "tags").map((t, i) =>
    assertNonEmptyString(t, `tags[${i}]`),
  );
  const tag_links = assertArray(o.tag_links, "tag_links").map(validateTagLink);
  return {
    version,
    currencies,
    bankcontacts,
    accounts,
    transactions,
    tags,
    tag_links,
  };
}
