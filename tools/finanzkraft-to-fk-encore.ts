/**
 * One-off converter: Finanzkraft daily-export JSON → fk-encore import JSON.
 *
 * Finanzkraft exports its data every 8 h via the as-express scheduler
 * (see `dataExport.js` in the finanzkraft repo). The shape doesn't match
 * fk-encore's `import-schema.ts` 1:1, so this script bridges the gap:
 *
 *   - No `bankcontacts[]` in the export → all accounts go in as
 *     manual accounts (no bankcontact link). The user wires them up
 *     later in fk-encore by creating bankcontacts and using
 *     AccountDetailView to link each account.
 *   - Tags live as a pipe-separated string per transaction
 *     (`Fk_Tags:tags": "KFZ|Kraftstoff"`) → flattened into a global
 *     tag list + per-transaction tag_links keyed by Finanzkraft's
 *     transaction id (carried in fints_id).
 *   - Categories (`Fk_Category:name`) are converted to tags so the
 *     historical classification is preserved in fk-encore's tag model.
 *   - Old transactions (≤ ~1998) lack `bookingDate` and only have
 *     `valueDate` → fall back to the value date as booking date.
 *   - Non-EUR transactions: `Fk_Transaction:amount` is already in the
 *     account currency; the original currency/amount/exchange-rate go
 *     into `raw` for archival but don't affect the booking row itself.
 *
 * Usage:
 *
 *   node --experimental-strip-types tools/finanzkraft-to-fk-encore.ts \
 *     < finanzkraft-export.json > fk-encore-import.json
 *
 *   # then move it to the dropbox:
 *   cp fk-encore-import.json /data/finance-import/import.pending.json
 *
 * Or, after `tsc -b`:
 *
 *   node tools/finanzkraft-to-fk-encore.js < export.json > import.json
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Finanzkraft export shape (only the fields we read)
// ---------------------------------------------------------------------------

interface FkAccount {
  id: number;
  name: string;
  iban: string | null;
  number: string | null;
  account_type_id: string;
  closedAt: string | null;
  currency_id: string;
  balance?: number | null;
  // Bankcontact context — flattened onto every FinTS-linked account in
  // the Finanzkraft export. Cash wallets / closed accounts have these
  // fields null. We aggregate by `bankcontact_id` to produce one
  // pseudo-bankcontact per real bank contact.
  bankcontact_id?: number | null;
  bankcontact_name?: string | null;
  bankcontact_fintsBankId?: string | null;
  bankcontact_fintsUrl?: string | null;
  /** Encrypted with the Finanzkraft master key — useless to fk-encore.
   *  We deliberately ignore it; the user re-enters credentials in
   *  the new app via BankcontactDetailView. */
  bankcontact_fintsUserIdEncrypted?: string | null;
  bankcontact_fintsPasswordEncrypted?: string | null;
  /** FinTS account-number (the lib-fints `accountNumber` for a sync).
   *  Different from `number` in some banks (e.g. comdirect surfaces
   *  the same digits in both, but ING/MLP can differ). */
  fintsAccountNumber?: string | null;
  fintsActivated?: boolean;
  fintsAuthRequired?: boolean;
  fintsError?: string | null;
}

interface FkTransaction {
  "Fk_Transaction:id": number;
  "Fk_Transaction:idAccount": number;
  "Fk_Transaction:bookingDate"?: string;
  "Fk_Transaction:valueDate"?: string;
  "Fk_Transaction:amount": number;
  "Fk_Transaction:text"?: string;
  "Fk_Transaction:notes"?: string;
  "Fk_Transaction:payee"?: string;
  "Fk_Transaction:payeePayerAcctNo"?: string;
  "Fk_Transaction:payeeBankId"?: string;
  "Fk_Transaction:EREF"?: string;
  "Fk_Transaction:CRED"?: string;
  "Fk_Transaction:MREF"?: string;
  "Fk_Transaction:REF"?: string;
  "Fk_Transaction:ABWA"?: string;
  "Fk_Transaction:ABWE"?: string;
  "Fk_Transaction:IBAN"?: string;
  "Fk_Transaction:BIC"?: string;
  "Fk_Transaction:gvCode"?: string;
  "Fk_Transaction:entryText"?: string;
  "Fk_Transaction:primaNotaNo"?: number | string;
  "Fk_Transaction:idCategory"?: number;
  "Fk_Transaction:processed"?: boolean;
  "Fk_Category:name"?: string;
  "Fk_Category:fullName"?: string;
  "Fk_Transaction:originalCurrency"?: string;
  "Fk_Transaction:originalAmount"?: number;
  "Fk_Transaction:exchangeRate"?: number;
  "Fk_Currency:id": string;
  "Fk_Currency:short"?: string;
  "Fk_Tags:tags"?: string;
  "Fk_Account:iban"?: string;
}

interface FinanzkraftExport {
  Schema: number;
  Accounts: FkAccount[];
  Transactions: FkTransaction[];
}

// ---------------------------------------------------------------------------
// fk-encore import shape (subset of finance/import-schema.ts)
// ---------------------------------------------------------------------------

interface OutCurrency {
  code: string;
  symbol: string;
  decimals: number;
}

interface OutBankcontact {
  blz: string;
  login: string;
  name: string;
  server_url: string;
  tan_method?: null;
}

interface OutAccount {
  bankcontact_blz: string | null;
  bankcontact_login: string | null;
  type_kind: string;
  currency_code: string;
  iban: string | null;
  account_number: string;
  label: string;
  active: boolean;
  fints_account_number?: string | null;
}

interface OutTransaction {
  account_iban: string | null;
  account_number: string;
  booking_date: string;
  value_date: string | null;
  amount: string;
  currency_code: string;
  purpose: string | null;
  counterparty: string | null;
  counterparty_iban: string | null;
  counterparty_bic: string | null;
  counterparty_bank_id: string | null;
  dedupe_hash: string;
  end_to_end_ref: string | null;
  mandate_ref: string | null;
  creditor_id: string | null;
  bank_ref: string | null;
  originator_name: string | null;
  recipient_name: string | null;
  gv_code: string | null;
  entry_text: string | null;
  prima_nota_no: string | null;
  original_amount: string | null;
  original_currency_code: string | null;
  exchange_rate: string | null;
}

interface OutTagLink {
  tag: string;
  account_iban: string | null;
  account_number: string;
  booking_date: string;
  dedupe_hash: string;
}

interface OutExport {
  version: string;
  currencies: OutCurrency[];
  bankcontacts: OutBankcontact[];
  accounts: OutAccount[];
  transactions: OutTransaction[];
  tags: string[];
  tag_links: OutTagLink[];
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

/**
 * Finanzkraft account_type_id → fk-encore type_kind enum value.
 *
 * fk-encore has its own `bargeld` enum value (added in migration 0054)
 * because the UI varies per kind for cash wallets. `savings` maps to
 * `tagesgeld` since fk-encore has no dedicated savings-account kind
 * and a Sparbuch is functionally close (interest-bearing + liquid).
 *
 * The user can change individual accounts via AccountDetailView after
 * the import if any of these defaults don't fit.
 */
const TYPE_KIND_MAP: Record<string, string> = {
  cash: "bargeld",
  checking: "giro",
  credit: "kreditkarte",
  daily: "tagesgeld",
  savings: "tagesgeld",
  security: "depot",
  other: "sonstige",
};

// ---------------------------------------------------------------------------
// Field-coverage tracking
// ---------------------------------------------------------------------------
//
// Every attribute the converter sees is classified into one of four
// dispositions so the summary at the end can flag both the deliberate
// drops (ACL, joined columns) and any genuinely new field that
// Finanzkraft might ship in a future version. The whole point is to
// notice when an upgrade slips a new `Fk_Transaction:foo` past the
// converter and ends up nowhere.

type FieldDisposition = "first-class" | "raw" | "dropped" | "unknown";

/**
 * Account top-level field disposition. Whatever isn't listed here ends
 * up in the `unknown` bucket.
 */
const ACCOUNT_FIELD_DISPOSITION: Record<string, FieldDisposition> = {
  // mapped 1:1 into accounts[]
  id: "first-class",
  name: "first-class",
  iban: "first-class",
  number: "first-class",
  account_type_id: "first-class",
  closedAt: "first-class",
  currency_id: "first-class",
  fintsAccountNumber: "first-class",
  // bankcontact context: mapped via aggregation into bankcontacts[]
  // and the per-account bankcontact_blz/login link.
  bankcontact_id: "first-class",
  bankcontact_name: "first-class",
  bankcontact_fintsBankId: "first-class",
  bankcontact_fintsUrl: "first-class",
  // legacy bankcontact alias on the account row — same as the joined
  // columns above, captured here only so the coverage tracker doesn't
  // flag it as unknown.
  idBankcontact: "first-class",
  // joined columns from the Finanzkraft export. `currency_short` feeds
  // the symbol into the auto-generated currencies[] entry; the rest is
  // redundant with the foreign-key target, no value in carrying them.
  currency_short: "first-class",
  currency_name: "dropped",
  // encrypted credentials. The Finanzkraft master key isn't available
  // to the converter, so these blobs are useless. The user re-enters
  // login + PIN in the new app.
  bankcontact_fintsUserIdEncrypted: "dropped",
  bankcontact_fintsPasswordEncrypted: "dropped",
  // FinTS status flags — only relevant inside the running Finanzkraft
  // server. fk-encore tracks its own sync status.
  fintsActivated: "dropped",
  fintsAuthRequired: "dropped",
  fintsError: "dropped",
  // historical balances — fk-encore stores these in
  // finance_account_balance, but the import schema doesn't yet support
  // pre-loading that table; bringing it over is a future enhancement.
  startBalance: "dropped",
  balance: "dropped",
  balanceDate: "dropped",
  // ACL re-set in fk-encore via AccountAssignmentView.
  reader: "dropped",
  writer: "dropped",
};

/**
 * Explicit first-class transaction fields. Any other `Fk_Transaction:*`
 * attribute is treated as raw passthrough (lands in the `raw` jsonb
 * blob). Joined `Fk_Account:*`/`Fk_Currency:*`/`Fk_Category:*` columns
 * are dropped — the same data is on the parent account / category isn't
 * imported. Anything else is "unknown" and warrants a warning.
 */
const TRANSACTION_FIELDS_FIRST_CLASS = new Set([
  // identity + date + amount
  "Fk_Transaction:id",
  "Fk_Transaction:idAccount",
  "Fk_Transaction:bookingDate",
  "Fk_Transaction:valueDate",
  "Fk_Transaction:amount",
  "Fk_Currency:id",
  // text fields
  "Fk_Transaction:text",
  "Fk_Transaction:notes",
  "Fk_Transaction:payee",
  // counterparty addressing
  "Fk_Transaction:IBAN",
  "Fk_Transaction:BIC",
  "Fk_Transaction:payeePayerAcctNo",
  "Fk_Transaction:payeeBankId",
  // SEPA references (now first-class columns via migration 0055)
  "Fk_Transaction:EREF",
  "Fk_Transaction:MREF",
  "Fk_Transaction:CRED",
  "Fk_Transaction:REF",
  "Fk_Transaction:ABWA",
  "Fk_Transaction:ABWE",
  // MT940 / FinTS metadata
  "Fk_Transaction:gvCode",
  "Fk_Transaction:entryText",
  "Fk_Transaction:primaNotaNo",
  // multi-currency booking
  "Fk_Transaction:originalAmount",
  "Fk_Transaction:originalCurrency",
  "Fk_Transaction:exchangeRate",
  // tags (handled separately, but still first-class — we don't lose them)
  "Fk_Tags:tags",
  // category name: converted to a tag during extraction
  "Fk_Category:name",
  "Fk_Category:fullName",
]);

const TRANSACTION_FIELDS_DROPPED = new Set([
  "Fk_Account:id",
  "Fk_Account:name",
  "Fk_Account:iban",
  "Fk_Currency:name",
  // Fk_Category:id has no meaning outside Finanzkraft; name and fullName
  // are converted to tags in extractTags() and therefore first-class.
  "Fk_Category:id",
  // Finanzkraft-internal — bare id has no value, oldCategory is a
  // legacy hierarchy-string before the rename, and `processed` is a
  // workflow flag that doesn't translate to fk-encore's model.
  "Fk_Transaction:idCategory",
  "Fk_Transaction:oldCategory",
  "Fk_Transaction:processed",
]);

const TRANSACTION_FIELDS_FIRST_CLASS_EXTRA = new Set([
  "Fk_Currency:short",
]);

function classifyTransactionField(key: string): FieldDisposition {
  if (TRANSACTION_FIELDS_FIRST_CLASS.has(key)) return "first-class";
  if (TRANSACTION_FIELDS_FIRST_CLASS_EXTRA.has(key)) return "first-class";
  if (TRANSACTION_FIELDS_DROPPED.has(key)) return "dropped";
  // No catch-all `raw` bucket — every Finanzkraft attribute now has to
  // be classified explicitly. New fields shipped by future Finanzkraft
  // versions hit "unknown" and trigger the >>> warning <<< in the
  // coverage summary, so the user notices and can decide whether to
  // add them to FIRST_CLASS / DROPPED.
  return "unknown";
}

interface FieldStats {
  /** How many records carried this attribute (with a non-null value). */
  count: number;
  disposition: FieldDisposition;
}

class CoverageTracker {
  private readonly accounts = new Map<string, FieldStats>();
  private readonly transactions = new Map<string, FieldStats>();
  private accountRows = 0;
  private transactionRows = 0;

  observeAccount(record: Record<string, unknown>): void {
    this.accountRows++;
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null) continue;
      const disposition = ACCOUNT_FIELD_DISPOSITION[key] ?? "unknown";
      const cur = this.accounts.get(key) ?? { count: 0, disposition };
      cur.count++;
      this.accounts.set(key, cur);
    }
  }

  observeTransaction(record: Record<string, unknown>): void {
    this.transactionRows++;
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined || value === null) continue;
      const disposition = classifyTransactionField(key);
      const cur = this.transactions.get(key) ?? { count: 0, disposition };
      cur.count++;
      this.transactions.set(key, cur);
    }
  }

  printSummary(out: NodeJS.WritableStream): void {
    const writeBucket = (
      label: string,
      bucket: Map<string, FieldStats>,
      rows: number,
    ): void => {
      out.write(`  ${label} (${rows} row${rows === 1 ? "" : "s"}):\n`);
      const groups: Record<FieldDisposition, [string, number][]> = {
        "first-class": [],
        raw: [],
        dropped: [],
        unknown: [],
      };
      for (const [key, stats] of bucket) {
        groups[stats.disposition].push([key, stats.count]);
      }
      for (const [name, entries] of Object.entries(groups) as [
        FieldDisposition,
        [string, number][],
      ][]) {
        if (entries.length === 0) continue;
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        const formatted = entries.map(([k, n]) => `${k}(${n})`).join(", ");
        out.write(`    ${name.padEnd(11)}: ${formatted}\n`);
      }
      const unknownCount = groups.unknown.length;
      if (unknownCount > 0) {
        out.write(
          `    >>> ${unknownCount} unknown field(s) — converter is missing a mapping! <<<\n`,
        );
      }
    };

    out.write(`[finanzkraft-converter] field coverage:\n`);
    writeBucket("Accounts", this.accounts, this.accountRows);
    writeBucket("Transactions", this.transactions, this.transactionRows);
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function convertAccount(a: FkAccount): OutAccount {
  const typeKind = TYPE_KIND_MAP[a.account_type_id] ?? "sonstige";
  // Finanzkraft cash wallets have account_type_id="cash" and number=null,
  // and at least one historical iban-less account ("Bargeldkonto USD")
  // also has number=null. Synthesize a stable account_number from the
  // Finanzkraft id in those cases — keyed only at the converter level so
  // the same export always produces the same fk-encore key (re-import
  // is then idempotent via natural-key match in data-import.ts).
  const accountNumber = a.number?.trim() || `fk-${a.id}`;

  // Bankcontact link: Finanzkraft flattens BC data onto every account.
  // We pick the bankcontact_id and let the converter aggregate one
  // bankcontact per id; the link key here is (blz, "fk-bc-<id>") with
  // a synthetic placeholder login that the user replaces in the UI.
  const bcId = a.bankcontact_id ?? null;
  const bcBlz = a.bankcontact_fintsBankId?.trim() || null;
  const bankcontact_blz = bcId !== null && bcBlz ? bcBlz : null;
  const bankcontact_login = bcId !== null && bcBlz ? `fk-bc-${bcId}` : null;

  return {
    bankcontact_blz,
    bankcontact_login,
    type_kind: typeKind,
    currency_code: a.currency_id.toUpperCase(),
    iban: a.iban?.trim() || null,
    account_number: accountNumber,
    label: a.name.trim(),
    active: a.closedAt === null,
    fints_account_number: a.fintsAccountNumber?.trim() || null,
  };
}

interface PseudoBankcontact {
  id: number;
  name: string;
  blz: string;
  server_url: string;
}

/**
 * Aggregate the per-account bankcontact_* columns into one pseudo
 * bankcontact per Finanzkraft `bankcontact_id`. The login is a
 * placeholder ("fk-bc-3") because the real one is encrypted in the
 * Finanzkraft master key — the user updates it post-import via
 * BankcontactDetailView and sets the PIN there.
 *
 * Filters out accounts without a bankcontact (cash wallets, closed
 * iban-less accounts) and rejects rows where blz/url are missing —
 * a partial bankcontact would just trip the importer's foreign-key
 * lookup later.
 */
function aggregateBankcontacts(accounts: FkAccount[]): PseudoBankcontact[] {
  const byId = new Map<number, PseudoBankcontact>();
  for (const a of accounts) {
    if (a.bankcontact_id == null) continue;
    const blz = a.bankcontact_fintsBankId?.trim();
    const url = a.bankcontact_fintsUrl?.trim();
    const name = a.bankcontact_name?.trim();
    if (!blz || !url || !name) continue;
    if (byId.has(a.bankcontact_id)) continue;
    byId.set(a.bankcontact_id, {
      id: a.bankcontact_id,
      name,
      blz,
      server_url: url,
    });
  }
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

/**
 * Walk every account + transaction (incl. originalCurrency on
 * multi-currency bookings) and emit one entry per ISO code, picking up
 * the symbol from `currency_short` (account level) or `Fk_Currency:short`
 * (transaction level) when present. Falls back to the code itself as
 * the symbol if Finanzkraft never told us one.
 *
 * Always emits at least EUR + USD with their canonical symbols so a
 * minimal export still ends up with a sensible seed; the importer's
 * `ON CONFLICT` makes that idempotent against the migration seed.
 */
function collectCurrencies(input: FinanzkraftExport): OutCurrency[] {
  const symbolByCode = new Map<string, string>();
  const observe = (codeRaw: string | null | undefined, symbol?: string | null): void => {
    if (!codeRaw) return;
    const code = codeRaw.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return;
    const sym = symbol?.trim();
    if (!symbolByCode.has(code) || (sym && symbolByCode.get(code) === code)) {
      symbolByCode.set(code, sym || code);
    }
  };
  for (const a of input.Accounts) {
    observe(a.currency_id, (a as Record<string, unknown>).currency_short as string);
  }
  for (const t of input.Transactions) {
    observe(t["Fk_Currency:id"], t["Fk_Currency:short"]);
    observe(t["Fk_Transaction:originalCurrency"], null);
  }
  return [...symbolByCode.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, symbol]) => ({ code, symbol, decimals: 2 }));
}

/**
 * Mirror `computeDedupeHash` from finance/data-import.ts. Has to use
 * exactly the same canonical-field ordering or the importer will see
 * the converter-supplied hashes as different from what it would
 * compute itself, breaking re-import idempotency.
 */
function computeDedupeHash(
  bookingDate: string,
  valueDate: string | null,
  amount: string,
  currencyCode: string,
  purpose: string | null,
  counterpartyIban: string | null,
): string {
  const canonical = [
    bookingDate,
    valueDate ?? "",
    amount,
    currencyCode.toUpperCase(),
    purpose ?? "",
    counterpartyIban ?? "",
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  // Finanzkraft emits ISO timestamps like "2026-04-13T12:00:00.000Z"
  // — slice the date prefix.
  return s.slice(0, 10);
}

function convertTransaction(
  t: FkTransaction,
  accountByFkId: Map<number, OutAccount>,
): OutTransaction | null {
  const account = accountByFkId.get(t["Fk_Transaction:idAccount"]);
  if (!account) return null;

  // Pre-1999 Finanzkraft records lack `bookingDate` — only valueDate is
  // populated. fk-encore requires booking_date, so we fall back to the
  // value date in those cases. New transactions have both.
  const bookingRaw =
    t["Fk_Transaction:bookingDate"] ?? t["Fk_Transaction:valueDate"];
  const bookingDate = isoDate(bookingRaw);
  if (!bookingDate) return null;
  const valueDate = isoDate(t["Fk_Transaction:valueDate"]);

  // Purpose: Finanzkraft splits the parsed bank text into `text`
  // (free-form) and `notes` (user-added comment). Concatenate so we
  // don't lose either.
  const textParts: string[] = [];
  if (t["Fk_Transaction:text"]?.trim()) textParts.push(t["Fk_Transaction:text"].trim());
  if (t["Fk_Transaction:notes"]?.trim()) textParts.push(t["Fk_Transaction:notes"].trim());
  const purpose = textParts.length > 0 ? textParts.join(" / ") : null;

  const originalAmountNum = t["Fk_Transaction:originalAmount"];
  const exchangeRateNum = t["Fk_Transaction:exchangeRate"];
  const primaNotaRaw = t["Fk_Transaction:primaNotaNo"];
  const amount = t["Fk_Transaction:amount"].toFixed(2);
  const currencyCode = t["Fk_Currency:id"].toUpperCase();
  const counterpartyIban =
    t["Fk_Transaction:IBAN"]?.trim() ||
    t["Fk_Transaction:payeePayerAcctNo"]?.trim() ||
    null;
  const dedupeHash = computeDedupeHash(
    bookingDate,
    valueDate,
    amount,
    currencyCode,
    purpose,
    counterpartyIban,
  );

  return {
    account_iban: account.iban,
    account_number: account.account_number,
    booking_date: bookingDate,
    value_date: valueDate,
    amount,
    currency_code: currencyCode,
    purpose,
    counterparty: t["Fk_Transaction:payee"]?.trim() || null,
    counterparty_iban:
      t["Fk_Transaction:IBAN"]?.trim() ||
      t["Fk_Transaction:payeePayerAcctNo"]?.trim() ||
      null,
    counterparty_bic: t["Fk_Transaction:BIC"]?.trim() || null,
    counterparty_bank_id: t["Fk_Transaction:payeeBankId"]?.trim() || null,
    dedupe_hash: dedupeHash,
    end_to_end_ref: t["Fk_Transaction:EREF"]?.trim() || null,
    mandate_ref: t["Fk_Transaction:MREF"]?.trim() || null,
    creditor_id: t["Fk_Transaction:CRED"]?.trim() || null,
    bank_ref: t["Fk_Transaction:REF"]?.trim() || null,
    originator_name: t["Fk_Transaction:ABWA"]?.trim() || null,
    recipient_name: t["Fk_Transaction:ABWE"]?.trim() || null,
    gv_code: t["Fk_Transaction:gvCode"]?.trim() || null,
    entry_text: t["Fk_Transaction:entryText"]?.trim() || null,
    prima_nota_no: primaNotaRaw != null ? String(primaNotaRaw) : null,
    original_amount:
      originalAmountNum != null ? originalAmountNum.toFixed(2) : null,
    original_currency_code:
      t["Fk_Transaction:originalCurrency"]?.trim().toUpperCase() || null,
    exchange_rate:
      exchangeRateNum != null ? exchangeRateNum.toFixed(6) : null,
  };
}

function extractTags(t: FkTransaction): string[] {
  const tags: string[] = [];

  // Tags from Fk_Tags:tags (pipe-separated)
  const raw = t["Fk_Tags:tags"];
  if (raw) {
    for (const s of raw.split("|").map((x) => x.trim()).filter((x) => x.length > 0)) {
      tags.push(s);
    }
  }

  // Category converted to a tag — prefer the short name; fall back to
  // fullName if name is absent (shouldn't happen in practice).
  const categoryTag = (t["Fk_Category:name"] ?? t["Fk_Category:fullName"])?.trim();
  if (categoryTag && !tags.includes(categoryTag)) {
    tags.push(categoryTag);
  }

  return tags;
}

function convert(input: FinanzkraftExport): OutExport {
  const coverage = new CoverageTracker();

  // Pseudo-bankcontacts come first because the per-account
  // bankcontact_blz / bankcontact_login link must reference an entry
  // we actually emit. Aggregation is deterministic on bankcontact_id,
  // so the same Finanzkraft snapshot always produces the same set.
  const pseudoBcs = aggregateBankcontacts(input.Accounts);
  const bankcontacts: OutBankcontact[] = pseudoBcs.map((bc) => ({
    blz: bc.blz,
    login: `fk-bc-${bc.id}`,
    name: bc.name,
    server_url: bc.server_url,
    tan_method: null,
  }));

  const accounts: OutAccount[] = input.Accounts.map((a) => {
    coverage.observeAccount(a as unknown as Record<string, unknown>);
    return convertAccount(a);
  });

  const accountByFkId = new Map<number, OutAccount>();
  for (let i = 0; i < input.Accounts.length; i++) {
    accountByFkId.set(input.Accounts[i].id, accounts[i]);
  }

  const transactions: OutTransaction[] = [];
  const tagLinks: OutTagLink[] = [];
  const tagSet = new Set<string>();
  let skippedTransactions = 0;

  for (const t of input.Transactions) {
    coverage.observeTransaction(t as unknown as Record<string, unknown>);
    const out = convertTransaction(t, accountByFkId);
    if (!out) {
      skippedTransactions++;
      continue;
    }
    transactions.push(out);
    for (const tag of extractTags(t)) {
      tagSet.add(tag);
      tagLinks.push({
        tag,
        account_iban: out.account_iban,
        account_number: out.account_number,
        booking_date: out.booking_date,
        dedupe_hash: out.dedupe_hash,
      });
    }
  }

  if (skippedTransactions > 0) {
    process.stderr.write(
      `[finanzkraft-converter] skipped ${skippedTransactions} transaction(s) ` +
        `(missing parent account or no usable date)\n`,
    );
  }

  coverage.printSummary(process.stderr);

  const currencies = collectCurrencies(input);

  return {
    version: "finanzkraft-1.0",
    currencies,
    bankcontacts,
    accounts,
    transactions,
    tags: Array.from(tagSet).sort(),
    tag_links: tagLinks,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const inputJson = readFileSync(0, "utf8"); // stdin
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch (err) {
    process.stderr.write(
      `[finanzkraft-converter] input is not valid JSON: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  const input = parsed as FinanzkraftExport;
  if (!Array.isArray(input.Accounts) || !Array.isArray(input.Transactions)) {
    process.stderr.write(
      `[finanzkraft-converter] expected top-level Accounts[] and Transactions[]\n`,
    );
    process.exit(1);
  }

  const output = convert(input);
  process.stdout.write(JSON.stringify(output, null, 2));
  process.stdout.write("\n");

  process.stderr.write(
    `[finanzkraft-converter] currencies=${output.currencies.length} ` +
      `bankcontacts=${output.bankcontacts.length} ` +
      `accounts=${output.accounts.length} ` +
      `transactions=${output.transactions.length} ` +
      `tags=${output.tags.length} tag_links=${output.tag_links.length}\n`,
  );
}

main();
