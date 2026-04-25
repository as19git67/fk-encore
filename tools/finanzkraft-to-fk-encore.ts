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
 *   - Categories are intentionally NOT imported — the new finance
 *     module classifies by tag only (see docs/finance-tagging-and-ai.md).
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
 *   # then upload fk-encore-import.json via /finanzen/admin/import
 *
 * Or, after `tsc -b`:
 *
 *   node tools/finanzkraft-to-fk-encore.js < export.json > import.json
 */

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
  "Fk_Transaction:IBAN"?: string;
  "Fk_Transaction:BIC"?: string;
  "Fk_Transaction:gvCode"?: string;
  "Fk_Transaction:entryText"?: string;
  "Fk_Transaction:primaNotaNo"?: number;
  "Fk_Transaction:idCategory"?: number;
  "Fk_Transaction:processed"?: boolean;
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

interface OutAccount {
  bankcontact_blz: null;
  bankcontact_login: null;
  type_kind: string;
  currency_code: string;
  iban: string | null;
  account_number: string;
  label: string;
  active: boolean;
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
  fints_id: string;
  raw: Record<string, unknown> | null;
}

interface OutTagLink {
  tag: string;
  fints_id: string;
}

interface OutExport {
  version: string;
  bankcontacts: never[];
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
  // joined columns from the Finanzkraft export — redundant with the
  // current foreign-key target, no value in carrying them.
  currency_name: "dropped",
  currency_short: "dropped",
  // historical balances — fk-encore stores these in
  // finance_account_balance, but the import schema doesn't yet support
  // pre-loading that table; bringing it over is a future enhancement.
  startBalance: "dropped",
  balance: "dropped",
  balanceDate: "dropped",
  // bankcontact link is reset by the user post-import.
  idBankcontact: "dropped",
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
  "Fk_Transaction:id",
  "Fk_Transaction:idAccount",
  "Fk_Transaction:bookingDate",
  "Fk_Transaction:valueDate",
  "Fk_Transaction:amount",
  "Fk_Transaction:text",
  "Fk_Transaction:notes",
  "Fk_Transaction:payee",
  "Fk_Transaction:IBAN",
  "Fk_Transaction:payeePayerAcctNo",
  "Fk_Currency:id",
  "Fk_Tags:tags",
]);

const TRANSACTION_FIELDS_DROPPED = new Set([
  "Fk_Account:id",
  "Fk_Account:name",
  "Fk_Account:iban",
  "Fk_Currency:name",
  "Fk_Currency:short",
  "Fk_Category:id",
  "Fk_Category:name",
  "Fk_Category:fullName",
]);

function classifyTransactionField(key: string): FieldDisposition {
  if (TRANSACTION_FIELDS_FIRST_CLASS.has(key)) return "first-class";
  if (TRANSACTION_FIELDS_DROPPED.has(key)) return "dropped";
  if (key.startsWith("Fk_Transaction:")) return "raw";
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
  return {
    bankcontact_blz: null,
    bankcontact_login: null,
    type_kind: typeKind,
    currency_code: a.currency_id.toUpperCase(),
    iban: a.iban?.trim() || null,
    account_number: accountNumber,
    label: a.name.trim(),
    active: a.closedAt === null,
  };
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

  // Carry every parsed bank-mandate field into `raw` so the original
  // SEPA structure (CRED/MREF/REF/EREF, IBAN/BIC, gvCode, original
  // currency, exchange rate) survives the migration.
  const raw: Record<string, unknown> = {
    finanzkraft_id: t["Fk_Transaction:id"],
  };
  for (const [key, value] of Object.entries(t)) {
    if (value === undefined || value === null || value === "") continue;
    if (key.startsWith("Fk_Transaction:") || key === "Fk_Tags:tags") {
      raw[key] = value;
    }
  }

  return {
    account_iban: account.iban,
    account_number: account.account_number,
    booking_date: bookingDate,
    value_date: valueDate,
    amount: t["Fk_Transaction:amount"].toFixed(2),
    currency_code: t["Fk_Currency:id"].toUpperCase(),
    purpose,
    counterparty: t["Fk_Transaction:payee"]?.trim() || null,
    counterparty_iban:
      t["Fk_Transaction:IBAN"]?.trim() ||
      t["Fk_Transaction:payeePayerAcctNo"]?.trim() ||
      null,
    fints_id: `fk-${t["Fk_Transaction:id"]}`,
    raw,
  };
}

function extractTags(t: FkTransaction): string[] {
  const raw = t["Fk_Tags:tags"];
  if (!raw) return [];
  return raw
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function convert(input: FinanzkraftExport): OutExport {
  const coverage = new CoverageTracker();

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
      tagLinks.push({ tag, fints_id: out.fints_id });
    }
  }

  if (skippedTransactions > 0) {
    process.stderr.write(
      `[finanzkraft-converter] skipped ${skippedTransactions} transaction(s) ` +
        `(missing parent account or no usable date)\n`,
    );
  }

  coverage.printSummary(process.stderr);

  return {
    version: "finanzkraft-1.0",
    bankcontacts: [],
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
    `[finanzkraft-converter] accounts=${output.accounts.length} ` +
      `transactions=${output.transactions.length} ` +
      `tags=${output.tags.length} tag_links=${output.tag_links.length}\n`,
  );
}

main();
