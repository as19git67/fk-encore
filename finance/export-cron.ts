/**
 * Daily JSON snapshot of every finance_* user-data table into the
 * `${FINANCE_EXPORT_DIR}/` volume.
 *
 * Why: the import-pending cron in `import-pending.ts` reads the same
 * fk-encore import shape that `import-schema.ts` defines, so pairing
 * it with a periodic export gives a worst-case recovery path that's
 * literally a `cp` away:
 *
 *   cp finance-export-2026-04-20.json /data/finance-import/pending/
 *   # next 5-minute tick wipes + restores
 *
 * What's exported:
 *   - currencies (stammdaten — re-seeded on import via Stage 0)
 *   - bankcontacts (NO credentials — write-only field, can't decrypt
 *     here without the key, and the import schema doesn't accept them
 *     anyway)
 *   - accounts (incl. fints_account_number for live-sync continuity)
 *   - transactions (every column, including SEPA fields from 0055)
 *   - tags (user-source only)
 *   - tag_links (composite-key flavour the importer expects)
 *
 * What's NOT exported:
 *   - account_balance — large, low-value: a fresh sync re-derives it.
 *   - account_access (ACL) — admin re-applies via AccountAssignmentView.
 *   - tan_session — transient, expires on its own.
 *   - tag_transaction with source='ai' — re-derived by the LLM on demand.
 *
 * Rotation: keep the most-recent FINANCE_EXPORT_KEEP files (default 30),
 * delete older. Filenames sort lexicographically by date so a simple
 * "drop the first N" is enough.
 */

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { api } from "encore.dev/api";
import log from "encore.dev/log";
import { eq, sql } from "drizzle-orm";

import { dailyAtUtc, schedule } from "../lib/local-cron";

import db from "../db/database";
import {
  financeAccount,
  financeAccountType,
  financeBankcontact,
  financeCurrency,
  financeTag,
  financeTagTransaction,
  financeTransaction,
} from "../db/schema";

console.log("[boot] finance/export-cron.ts: all imports resolved");

// -----------------------------------------------------------------------

export const FINANCE_EXPORT_DIR =
  process.env.FINANCE_EXPORT_DIR ?? "/data/finance-export";

const FINANCE_EXPORT_KEEP = (() => {
  const raw = process.env.FINANCE_EXPORT_KEEP;
  if (!raw) return 30;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

interface ExportResult {
  filename: string;
  bytes: number;
  counts: {
    currencies: number;
    bankcontacts: number;
    accounts: number;
    transactions: number;
    tags: number;
    tag_links: number;
  };
  rotated: number;
}

export const runFinanceExport = api(
  {
    expose: false,
    method: "POST",
    path: "/internal/finance/export-snapshot",
  },
  async (): Promise<ExportResult> => {
    await mkdir(FINANCE_EXPORT_DIR, { recursive: true });

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `finance-export-${today}.json`;
    const abs = path.join(FINANCE_EXPORT_DIR, filename);

    const snapshot = await buildSnapshot();
    const json = JSON.stringify(snapshot, null, 2);
    await writeFile(abs, json, "utf8");

    const rotated = await rotateExports(filename);

    log.info("runFinanceExport: snapshot written", {
      filename,
      bytes: json.length,
      counts: countOf(snapshot),
      rotated,
    });

    return {
      filename,
      bytes: json.length,
      counts: countOf(snapshot),
      rotated,
    };
  },
);

// -----------------------------------------------------------------------
// Snapshot builder — shape matches finance/import-schema.ts so a
// snapshot can be dropped into pending/ and re-imported as-is.
// -----------------------------------------------------------------------

interface Snapshot {
  version: string;
  generated_at: string;
  currencies: Array<{ code: string; symbol: string; decimals: number }>;
  bankcontacts: Array<{
    blz: string;
    login: string;
    name: string;
    server_url: string;
    tan_method: string | null;
  }>;
  accounts: Array<{
    bankcontact_blz: string | null;
    bankcontact_login: string | null;
    type_kind: string;
    currency_code: string;
    iban: string | null;
    account_number: string;
    label: string;
    active: boolean;
    fints_account_number: string | null;
  }>;
  transactions: Array<Record<string, unknown>>;
  tags: string[];
  tag_links: Array<{
    tag: string;
    account_iban: string | null;
    account_number: string;
    booking_date: string;
    dedupe_hash: string;
  }>;
}

async function buildSnapshot(): Promise<Snapshot> {
  const currencies = await db.select().from(financeCurrency);
  const bankcontacts = await db.select().from(financeBankcontact);
  const accountTypes = await db.select().from(financeAccountType);
  const accounts = await db.select().from(financeAccount);
  const transactions = await db.select().from(financeTransaction);
  const tags = await db
    .select()
    .from(financeTag)
    .where(eq(financeTag.source, "user"));
  // Only export user-tag links — AI suggestions are derived on demand
  // and would create churn between exports.
  const tagLinks = await db
    .select({
      tag: financeTag.name,
      transaction_id: financeTagTransaction.transaction_id,
    })
    .from(financeTagTransaction)
    .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
    .where(eq(financeTag.source, "user"));

  const bcById = new Map(bankcontacts.map((b) => [b.id, b]));
  const typeById = new Map(accountTypes.map((t) => [t.id, t.kind]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const txById = new Map(transactions.map((t) => [t.id, t]));

  return {
    version: "fk-encore-finance-1.0",
    generated_at: new Date().toISOString(),
    currencies: currencies.map((c) => ({
      code: c.code,
      symbol: c.symbol,
      decimals: c.decimals,
    })),
    bankcontacts: bankcontacts.map((b) => ({
      blz: b.blz,
      login: b.login,
      name: b.name,
      server_url: b.server_url,
      tan_method: b.tan_method,
    })),
    accounts: accounts.map((a) => {
      const bc = a.bankcontact_id !== null ? bcById.get(a.bankcontact_id) : null;
      return {
        bankcontact_blz: bc?.blz ?? null,
        bankcontact_login: bc?.login ?? null,
        type_kind: typeById.get(a.type_id) ?? "sonstige",
        currency_code: a.currency_code,
        iban: a.iban,
        account_number: a.account_number,
        label: a.label,
        active: a.active,
        fints_account_number: a.fints_account_number,
      };
    }),
    transactions: transactions.map((t) => {
      const acc = accountById.get(t.account_id);
      return {
        account_iban: acc?.iban ?? null,
        account_number: acc?.account_number ?? "",
        booking_date: t.booking_date.slice(0, 10),
        value_date: t.value_date ? t.value_date.slice(0, 10) : null,
        amount: t.amount,
        currency_code: t.currency_code,
        purpose: t.purpose,
        counterparty: t.counterparty,
        counterparty_iban: t.counterparty_iban,
        counterparty_bic: t.counterparty_bic,
        counterparty_bank_id: t.counterparty_bank_id,
        end_to_end_ref: t.end_to_end_ref,
        mandate_ref: t.mandate_ref,
        creditor_id: t.creditor_id,
        bank_ref: t.bank_ref,
        originator_name: t.originator_name,
        recipient_name: t.recipient_name,
        gv_code: t.gv_code,
        entry_text: t.entry_text,
        prima_nota_no: t.prima_nota_no,
        original_amount: t.original_amount,
        original_currency_code: t.original_currency_code,
        exchange_rate: t.exchange_rate,
        dedupe_hash: t.dedupe_hash,
      };
    }),
    tags: tags.map((t) => t.name).sort(),
    tag_links: tagLinks
      .map((tl) => {
        const tx = txById.get(tl.transaction_id);
        if (!tx) return null;
        const acc = accountById.get(tx.account_id);
        return {
          tag: tl.tag,
          account_iban: acc?.iban ?? null,
          account_number: acc?.account_number ?? "",
          booking_date: tx.booking_date.slice(0, 10),
          dedupe_hash: tx.dedupe_hash,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  };
}

function countOf(s: Snapshot): ExportResult["counts"] {
  return {
    currencies: s.currencies.length,
    bankcontacts: s.bankcontacts.length,
    accounts: s.accounts.length,
    transactions: s.transactions.length,
    tags: s.tags.length,
    tag_links: s.tag_links.length,
  };
}

// -----------------------------------------------------------------------
// Rotation
// -----------------------------------------------------------------------

async function rotateExports(currentFilename: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(FINANCE_EXPORT_DIR);
  } catch {
    return 0;
  }
  // Same-day re-runs overwrite the file (filename has only the date),
  // so dedup happens naturally. Filter to our snapshot prefix.
  const snapshots = entries
    .filter((e) => e.startsWith("finance-export-") && e.endsWith(".json"))
    .sort();
  if (snapshots.length <= FINANCE_EXPORT_KEEP) return 0;

  const toDelete = snapshots.slice(0, snapshots.length - FINANCE_EXPORT_KEEP);
  let deleted = 0;
  for (const name of toDelete) {
    if (name === currentFilename) continue; // safety: never delete the file we just wrote
    try {
      await unlink(path.join(FINANCE_EXPORT_DIR, name));
      deleted++;
    } catch (err) {
      log.warn("runFinanceExport: failed to delete old snapshot", {
        file: name,
        err: (err as Error).message,
      });
    }
  }
  return deleted;
}

// -----------------------------------------------------------------------

// 03:00 UTC every day — late enough to overlap the early-morning
// bank syncs in finance-fints-integration.md §5 without contention.
schedule({
  name: "finance-export-snapshot",
  nextFire: dailyAtUtc(3, 0),
  run: () => runFinanceExport(),
});
