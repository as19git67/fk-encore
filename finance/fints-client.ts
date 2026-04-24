/**
 * Thin facade over `lib-fints` for the finance module.
 *
 * Responsibilities:
 *   - load a finance_bankcontact row (with encrypted credentials) and
 *     decrypt the PIN on the way into the FinTS dialog;
 *   - expose a single `runSynchronize()` that works both ways: start a
 *     fresh sync dialog, or resume one that was suspended by a TAN
 *     challenge on the previous call;
 *   - map the boolean-flag-heavy lib-fints `ClientResponse` into our
 *     state-discriminated `DialogResult` so callers (statements
 *     endpoint, sync cron) can switch on a single field;
 *   - retry network-level failures with a small exponential backoff;
 *     PIN and dialog errors (e.g. FinTS code 9910 = wrong PIN) do NOT
 *     retry — the user has to fix credentials first.
 *
 * Statement / balance fetching and the specialised `…WithTan` paths
 * for those come in Etappe 3 — this module only handles the
 * synchronize dialog for now.
 *
 * Architecture: docs/finance-fints-integration.md §2.
 */

import { eq } from "drizzle-orm";
import {
  FinTSClient,
  FinTSConfig,
  type BankingInformation,
  type BankAnswer,
} from "lib-fints";
import { secret } from "encore.dev/config";

import db from "../db/database";
import { financeBankcontact } from "../db/schema";
import { decryptCredentials } from "./encryption";
import type {
  DialogResult,
  FetchResult,
  FintsAccountSnapshot,
  FintsTransactionData,
  SyncOptions,
} from "./types";

console.log("[boot] finance/fints-client.ts: all imports resolved");

// Product registration with ZKA (Deutsche Kreditwirtschaft) is mandatory
// per PSD2. Dev / CI defaults let tests run without registering; prod
// deployments MUST set both secrets to real ZKA-issued values.
const productId = secret("FinanceFintsProductId");
const productVersion = secret("FinanceFintsProductVersion");

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [2_000, 4_000];

/** Subset of lib-fints surface the wrapper uses — lets tests swap the constructor without module-level mocking. */
export interface FintsClientSurface {
  synchronize(): Promise<import("lib-fints").SynchronizeResponse>;
  synchronizeWithTan(
    tanReference: string,
    tan?: string,
  ): Promise<import("lib-fints").SynchronizeResponse>;
  selectTanMethod(id: number): unknown;
  config: {
    bankingInformation: BankingInformation;
    availableTanMethods: import("lib-fints").TanMethod[];
  };
  getAccountStatements(
    accountNumber: string,
  ): Promise<import("lib-fints").StatementResponse>;
  getAccountStatementsWithTan(
    tanReference: string,
    tan?: string,
  ): Promise<import("lib-fints").StatementResponse>;
  getAccountBalance(
    accountNumber: string,
  ): Promise<import("lib-fints").AccountBalanceResponse>;
  getAccountBalanceWithTan(
    tanReference: string,
    tan?: string,
  ): Promise<import("lib-fints").AccountBalanceResponse>;
}

/** Constructor shape the wrapper needs; the default uses `lib-fints`. */
export type FintsClientFactory = (config: FinTSConfig) => FintsClientSurface;

const defaultFactory: FintsClientFactory = (config) =>
  new FinTSClient(config) as unknown as FintsClientSurface;

interface RunOptions extends SyncOptions {
  /** Test seam: override the FinTSClient constructor. */
  clientFactory?: FintsClientFactory;
  /** Test seam: sleep function (for deterministic backoff testing). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs a FinTS synchronize dialog for the given bankcontact.
 *
 * Fresh path:  `opts = {}` (or only the test seams)
 * Resume path: pass `tanReference`, `bankingInformation`, and
 *              `tanAnswer` (undefined is legit for decoupled TAN).
 *
 * Two-call sync contract (per lib-fints README §2): on a cold start,
 * the first `synchronize()` returns BPD only (TAN methods etc.) and
 * no UPD (account list), because the TAN method has to be selected
 * *before* the call that can return UPD. The second `synchronize()`
 * after `selectTanMethod(...)` returns the full bankingInformation
 * with `upd.bankAccounts` populated — or requires a TAN, in which
 * case we hand control back to the UI and resume via
 * `synchronizeWithTan(...)`.
 */
export async function runSynchronize(
  bankcontactId: number,
  opts: RunOptions = {},
): Promise<DialogResult> {
  const bankcontact = await loadBankcontact(bankcontactId);
  const pin = bankcontact.credentials_encrypted
    ? decryptCredentials(bankcontact.credentials_encrypted)
    : "";

  const factory = opts.clientFactory ?? defaultFactory;
  const sleep = opts.sleep ?? defaultSleep;

  const isResume = typeof opts.tanReference === "string"
    && !!opts.bankingInformation;

  return runWithRetry(async () => {
    if (isResume) {
      // Resume path — bankingInformation already contains BPD; the
      // pending dialog is simply continued with the user's TAN.
      const config = FinTSConfig.fromBankingInformation(
        productId(),
        productVersion(),
        opts.bankingInformation as unknown as BankingInformation,
        bankcontact.login,
        pin,
        bankcontact.tan_method ? parseInt(bankcontact.tan_method, 10) : undefined,
      );
      const client = factory(config);
      const response = await client.synchronizeWithTan(
        opts.tanReference!,
        opts.tanAnswer,
      );
      const result = mapResponse(response, client.config.bankingInformation);
      if (result.state === "idle") result.client = client;
      return result;
    }

    // Fresh path — first sync fetches BPD so availableTanMethods is
    // populated before we can call selectTanMethod().
    const config = FinTSConfig.forFirstTimeUse(
      productId(),
      productVersion(),
      bankcontact.server_url,
      bankcontact.blz,
      bankcontact.login,
      pin,
    );
    const client = factory(config);

    const bpdResponse = await client.synchronize();
    // If even the BPD-only sync comes back as a failure or TAN-
    // required, surface that verbatim — don't try the second call.
    const bpdMapped = mapResponse(bpdResponse, client.config.bankingInformation);
    if (bpdMapped.state !== "idle") {
      return bpdMapped;
    }

    // A TAN method must be configured before the second sync —
    // otherwise we have no way to know which method to request.
    // The UI's BankcontactForm exposes this as a mandatory numeric
    // picker (see docs/finance-frontend.md §3).
    if (!bankcontact.tan_method) {
      return {
        state: "error",
        errorCode: "no-tan-method",
        errorMessage:
          "No TAN method configured on bankcontact. Pick one from the " +
          "available methods returned by the bank and update the " +
          "bankcontact before retrying.",
      };
    }
    client.selectTanMethod(parseInt(bankcontact.tan_method, 10));

    const updResponse = await client.synchronize();
    const result = mapResponse(updResponse, client.config.bankingInformation);
    // Expose the live client on successful init so callers can follow
    // up with getAccountStatements / getAccountBalance without a
    // fresh authenticate-dance. Retained only in-process; never
    // persisted.
    if (result.state === "idle") result.client = client;
    return result;
  }, sleep);
}

// -----------------------------------------------------------------------
// Probe for available TAN methods (pre-sync UI lookup)
// -----------------------------------------------------------------------

export interface ProbeTanMethod {
  id: number;
  name: string;
  isDecoupled: boolean;
}

export interface ProbeTanMethodsResult {
  /** Matches DialogResult so callers can handle the TAN / error
   *  branches uniformly with the regular sync flow. */
  state: "ok" | "tan-required" | "error";
  methods?: ProbeTanMethod[];
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Runs *only* the first synchronize() dialog — the one that populates
 * BPD including the list of TAN methods the bank offers for this
 * user. No TAN method is selected afterwards, so the bank isn't
 * asked for UPD (account list) and the user doesn't see a TAN
 * challenge on the pre-sync pass.
 *
 * This is what powers the "TAN-Verfahren abrufen"-button in
 * BankcontactDetailView: the admin doesn't have to know the numeric
 * FinTS ID of the method upfront anymore.
 */
export async function probeTanMethods(
  bankcontactId: number,
  opts: { clientFactory?: FintsClientFactory; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ProbeTanMethodsResult> {
  const bankcontact = await loadBankcontact(bankcontactId);
  const pin = bankcontact.credentials_encrypted
    ? decryptCredentials(bankcontact.credentials_encrypted)
    : "";

  const factory = opts.clientFactory ?? defaultFactory;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const config = FinTSConfig.forFirstTimeUse(
        productId(),
        productVersion(),
        bankcontact.server_url,
        bankcontact.blz,
        bankcontact.login,
        pin,
      );
      const client = factory(config);

      const response = await client.synchronize();
      // If the first sync itself demands a TAN, hand that back — the
      // caller (UI) has to tell the user to remove the TAN lock on
      // their account before the probe can go through. Rare in
      // practice; most banks only challenge on the second sync.
      if (response.requiresTan) {
        return {
          state: "tan-required",
          errorCode: "tan-before-probe",
          errorMessage:
            "Bank requires a TAN before exposing the method list. " +
            "Please reach out to the bank to reset the session.",
        };
      }
      if (!response.success) {
        const first = response.bankAnswers.find((a) => a.code !== 0)
          ?? response.bankAnswers[0];
        return {
          state: "error",
          errorCode: first ? String(first.code) : "unknown",
          errorMessage: first?.text ?? "FinTS probe failed",
        };
      }
      const methods = (client.config.availableTanMethods ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        isDecoupled: m.isDecoupled,
      }));
      return { state: "ok", methods };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return {
    state: "error",
    errorCode: "transport",
    errorMessage: `FinTS transport error after ${MAX_RETRIES + 1} attempts: ${msg}`,
  };
}

// -----------------------------------------------------------------------
// Statements + balance fetch (after a successful init dialog)
// -----------------------------------------------------------------------

/**
 * Iterates the accounts known to the client (lib-fints populates
 * `config.bankingInformation.upd.bankAccounts` during synchronize),
 * fetches statements + balance for each, and returns them as a
 * structured snapshot ready for persistence.
 *
 * Mid-flight TAN: if any per-account fetch comes back with
 * `requiresTan=true`, we record a soft error on the account and move
 * on. The caller can choose to let the user retrigger the sync
 * (which will re-run the init dialog and then try the skipped
 * fetches again). Most banks only require TAN on the init dialog, so
 * this is a rare path.
 */
export async function runFetchAccounts(
  client: FintsClientSurface,
): Promise<FetchResult> {
  const bi = client.config.bankingInformation;
  const accounts =
    (bi as unknown as {
      upd?: { bankAccounts?: RawBankAccount[] };
    }).upd?.bankAccounts ?? [];

  const snapshots: FintsAccountSnapshot[] = [];
  let partial = false;

  for (const account of accounts) {
    const snapshot = await fetchOneAccount(client, account);
    if (snapshot.errors.length > 0) partial = true;
    snapshots.push(snapshot);
  }

  return { accounts: snapshots, partial };
}

interface RawBankAccount {
  accountNumber: string;
  iban?: string;
  currency?: string;
  accountType?: string;
  holder1?: string;
  product?: string;
}

async function fetchOneAccount(
  client: FintsClientSurface,
  account: RawBankAccount,
): Promise<FintsAccountSnapshot> {
  const accountKind = mapAccountKind(account.accountType);
  const currency = account.currency ?? "EUR";
  const label = buildAccountLabel(account);

  const snapshot: FintsAccountSnapshot = {
    accountNumber: account.accountNumber,
    iban: account.iban ?? null,
    accountKind,
    currency,
    label,
    balance: null,
    transactions: [],
    errors: [],
  };

  try {
    const stmtResp = await client.getAccountStatements(account.accountNumber);
    if (stmtResp.requiresTan) {
      snapshot.errors.push("statements-tan-required");
    } else if (!stmtResp.success) {
      const first = stmtResp.bankAnswers.find((a) => a.code !== 0);
      snapshot.errors.push(
        `statements-error:${first?.code ?? "unknown"} ${first?.text ?? ""}`.trim(),
      );
    } else {
      snapshot.transactions = mapStatements(stmtResp.statements ?? [], currency);
    }
  } catch (err) {
    snapshot.errors.push(
      `statements-exception:${(err as Error).message ?? String(err)}`,
    );
  }

  try {
    const balResp = await client.getAccountBalance(account.accountNumber);
    if (balResp.requiresTan) {
      snapshot.errors.push("balance-tan-required");
    } else if (!balResp.success) {
      const first = balResp.bankAnswers.find((a) => a.code !== 0);
      snapshot.errors.push(
        `balance-error:${first?.code ?? "unknown"} ${first?.text ?? ""}`.trim(),
      );
    } else if (balResp.balance) {
      snapshot.balance = {
        asOf: toIsoDate(balResp.balance.date),
        amount: toAmountString(balResp.balance.balance),
        currency: balResp.balance.currency ?? currency,
      };
    }
  } catch (err) {
    snapshot.errors.push(
      `balance-exception:${(err as Error).message ?? String(err)}`,
    );
  }

  return snapshot;
}

/** Map lib-fints AccountType (enum string) → finance_account_kind value. */
function mapAccountKind(accountType: string | undefined): string {
  switch (accountType) {
    case "CheckingAccount":
      return "giro";
    case "SavingsAccount":
      return "tagesgeld";
    case "FixedDepositAccount":
      return "festgeld";
    case "SecuritiesAccount":
      return "depot";
    case "LoanMortgageAccount":
      return "kredit";
    case "CreditCardAccount":
      return "kreditkarte";
    case "HomeSavingsContract":
      return "bausparen";
    default:
      return "sonstige";
  }
}

function buildAccountLabel(account: RawBankAccount): string {
  const typeLabel = account.product ?? account.accountType ?? "Konto";
  const holder = account.holder1 ? ` – ${account.holder1}` : "";
  return `${typeLabel} ${account.accountNumber}${holder}`.trim();
}

function mapStatements(
  statements: Array<{
    transactions?: Array<{
      valueDate?: Date | string;
      entryDate?: Date | string;
      amount?: number;
      purpose?: string;
      remoteName?: string;
      remoteIdentifier?: string;
      bankReference?: string;
      [key: string]: unknown;
    }>;
  }>,
  currency: string,
): FintsTransactionData[] {
  const out: FintsTransactionData[] = [];
  for (const stmt of statements) {
    for (const t of stmt.transactions ?? []) {
      if (t.amount === undefined || t.entryDate === undefined) continue;
      out.push({
        bookingDate: toIsoDate(t.entryDate),
        valueDate: t.valueDate ? toIsoDate(t.valueDate) : null,
        amount: toAmountString(t.amount),
        currency,
        purpose: t.purpose?.trim() || null,
        counterparty: t.remoteName?.trim() || null,
        counterpartyIban: t.remoteIdentifier?.trim() || null,
        fintsId: t.bankReference?.trim() || null,
        raw: t as Record<string, unknown>,
      });
    }
  }
  return out;
}

function toIsoDate(d: Date | string): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "string") return d.slice(0, 10);
  return "";
}

function toAmountString(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

async function loadBankcontact(
  id: number,
): Promise<typeof financeBankcontact.$inferSelect> {
  const rows = await db
    .select()
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`finance_bankcontact ${id} not found`);
  }
  return row;
}

/**
 * Maps a lib-fints ClientResponse to our DialogResult. See
 * docs/finance-fints-integration.md §2.3 for the code table —
 * non-zero first bankAnswer.code becomes errorCode when
 * success=false.
 */
function mapResponse(
  response: {
    success: boolean;
    requiresTan: boolean;
    tanChallenge?: string;
    tanReference?: string;
    tanMediaName?: string;
    bankAnswers: BankAnswer[];
  },
  bankingInformation: BankingInformation,
): DialogResult {
  if (response.requiresTan) {
    return {
      state: "tan-required",
      bankingInformation: bankingInformation as unknown as Record<string, unknown>,
      tanChallenge: response.tanChallenge,
      tanReference: response.tanReference,
      tanMediaName: response.tanMediaName,
    };
  }
  if (response.success) {
    return {
      state: "idle",
      bankingInformation: bankingInformation as unknown as Record<string, unknown>,
    };
  }
  // success=false: pick the first non-zero bank answer as the error
  const first = response.bankAnswers.find((a) => a.code !== 0)
    ?? response.bankAnswers[0];
  return {
    state: "error",
    errorCode: first ? String(first.code) : "unknown",
    errorMessage: first?.text ?? "FinTS dialog failed",
  };
}

/**
 * Retries the inner function on transport-level exceptions (network
 * errors, timeouts). Dialog-level failures — signalled via
 * DialogResult with state="error" — are NOT retried; the caller sees
 * them on the first try.
 */
async function runWithRetry(
  fn: () => Promise<DialogResult>,
  sleep: (ms: number) => Promise<void>,
): Promise<DialogResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }
  }
  // Budget exhausted — surface as an "error" DialogResult rather than
  // a thrown exception, so callers can treat transport failures
  // uniformly with dialog failures.
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return {
    state: "error",
    errorCode: "transport",
    errorMessage: `FinTS transport error after ${MAX_RETRIES + 1} attempts: ${msg}`,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
