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
    selectedTanMethod?: import("lib-fints").TanMethod;
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
 *   Resume path : `tanReference` + `bankingInformation` (+optional
 *                 `tanAnswer`) — submit the TAN the user just typed,
 *                 continue the suspended dialog. No fresh push.
 *
 *   Warm path   : when `bankcontact.banking_information` is cached
 *                 *and* a `tan_method` is configured, build the
 *                 client via `FinTSConfig.fromBankingInformation`.
 *                 The bank recognises our `systemId` and — under
 *                 PSD2's 90-day rule for read-only ops — usually
 *                 lets us through without a TAN. Single
 *                 `synchronize()` call. If it does demand a TAN,
 *                 the decoupled-poll helper handles pushTAN; coupled
 *                 methods bubble up as `tan-required` for the UI.
 *
 *   Cold path   : no cached BI (or warm path threw) — the original
 *                 two-call dance with `forFirstTimeUse`. The first
 *                 `synchronize()` is retry-wrapped because it has no
 *                 user-visible side effects yet; the second sync +
 *                 decoupled poll runs exactly once to avoid a
 *                 duplicate push (see commit 183762e).
 *
 * After every `state="idle"` outcome we persist the live
 * `client.config.bankingInformation` back to the bankcontact row so
 * the next sync hits the warm path.
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

  // ── Resume path ────────────────────────────────────────────────────
  if (isResume) {
    const result = await runWithRetry(async () => {
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
      const mapped = mapResponse(response, client.config.bankingInformation);
      if (mapped.state === "idle") mapped.client = client;
      return mapped;
    }, sleep);
    if (result.state === "idle" && result.client) {
      await persistBankingInformation(
        bankcontactId,
        (result.client as FintsClientSurface).config.bankingInformation,
      );
      console.log(
        `[fints] resume sync ok for bankcontact=${bankcontactId}, ` +
          `bankingInformation cached for next warm-start`,
      );
    }
    return result;
  }

  // ── Warm path ──────────────────────────────────────────────────────
  // Skipped without preconditions: needs both cached BI *and* a
  // configured TAN method (the BI carries the systemId; the method id
  // tells lib-fints which TAN procedure to keep selected).
  const cachedBi = bankcontact.banking_information;
  const cachedTanMethodId = bankcontact.tan_method
    ? parseInt(bankcontact.tan_method, 10)
    : NaN;
  if (cachedBi && Number.isFinite(cachedTanMethodId)) {
    console.log(
      `[fints] warm-start sync for bankcontact=${bankcontactId} — ` +
        `reusing cached bankingInformation, single synchronize()`,
    );
    try {
      const warm = await runWarmSync(
        bankcontact,
        pin,
        cachedBi as Record<string, unknown>,
        cachedTanMethodId,
        factory,
        sleep,
      );
      if (warm.state === "idle" && warm.client) {
        await persistBankingInformation(
          bankcontactId,
          (warm.client as FintsClientSurface).config.bankingInformation,
        );
        console.log(
          `[fints] warm sync ok for bankcontact=${bankcontactId} ` +
            `(no TAN required), bankingInformation refreshed`,
        );
        return warm;
      }
      // tan-required / coupled — return as-is, the UI / TAN flow
      // takes over and the resume branch will persist BI later.
      if (warm.state === "tan-required") {
        console.log(
          `[fints] warm sync for bankcontact=${bankcontactId} → ` +
            `tan-required (PSD2 90-day window likely expired)`,
        );
        return warm;
      }
      // state=error from a warm sync usually means the bank rejected
      // the cached systemId or the session is otherwise stale.
      // Fall through to the cold path below.
      console.warn(
        `[fints] warm sync for bankcontact=${bankcontactId} returned ` +
          `state=error (${warm.errorCode}); falling back to cold init`,
      );
    } catch (err) {
      console.warn(
        `[fints] warm sync for bankcontact=${bankcontactId} threw; ` +
          `falling back to cold init: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── Cold path ──────────────────────────────────────────────────────
  // Splits into two phases:
  //
  //   (a) RETRY-WRAPPED  : forFirstTimeUse + BPD-only synchronize().
  //                         This part is side-effect-free from the
  //                         user's perspective (no TAN / push yet).
  //                         Transient transport errors retry freely.
  //
  //   (b) NO-RETRY       : selectTanMethod + UPD-synchronize +
  //                         decoupled poll. A retry here would build
  //                         a second FinTSConfig.forFirstTimeUse and
  //                         trigger a *second* TAN push at the bank.
  //                         Any failure past this point surfaces as
  //                         state="error" without retry.
  console.log(
    `[fints] cold-start sync for bankcontact=${bankcontactId} — ` +
      `forFirstTimeUse + two-call dance` +
      (cachedBi ? ` (cached BI was discarded after warm path failed)` : ``),
  );
  let client: FintsClientSurface;
  try {
    const firstSync = await runWithRetry(async () => {
      const config = FinTSConfig.forFirstTimeUse(
        productId(),
        productVersion(),
        bankcontact.server_url,
        bankcontact.blz,
        bankcontact.login,
        pin,
      );
      const c = factory(config);
      const bpdResponse = await c.synchronize();
      const mapped = mapResponse(bpdResponse, c.config.bankingInformation);
      mapped.client = c;
      return mapped;
    }, sleep);

    if (firstSync.state !== "idle" || !firstSync.client) {
      const { client: _c, ...rest } = firstSync;
      void _c;
      return rest;
    }
    client = firstSync.client as FintsClientSurface;
  } catch (err) {
    return {
      state: "error",
      errorCode: "transport",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  // --- Phase (b): from here on, no retry, no second forFirstTimeUse ---

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
  const tanMethodId = parseInt(bankcontact.tan_method, 10);
  const available = client.config.availableTanMethods ?? [];
  if (!available.some((m) => m.id === tanMethodId)) {
    const list = available.length
      ? available.map((m) => `${m.id} (${m.name})`).join(", ")
      : "none returned by bank";
    return {
      state: "error",
      errorCode: "unknown-tan-method",
      errorMessage:
        `Configured TAN method '${tanMethodId}' is not offered by the bank. ` +
        `Available: ${list}. Re-probe via the UI's "Abrufen" button and ` +
        `pick an available one.`,
    };
  }
  client.selectTanMethod(tanMethodId);

  try {
    const updResponse = await client.synchronize();
    const finalResponse = await pollDecoupledIfNeeded(
      client,
      updResponse,
      sleep,
    );
    const result = mapResponse(finalResponse, client.config.bankingInformation);
    if (result.state === "idle") {
      result.client = client;
      await persistBankingInformation(
        bankcontactId,
        client.config.bankingInformation,
      );
      console.log(
        `[fints] cold sync ok for bankcontact=${bankcontactId}, ` +
          `bankingInformation cached for next warm-start`,
      );
    }
    return result;
  } catch (err) {
    return {
      state: "error",
      errorCode: "post-first-sync-transport",
      errorMessage:
        "FinTS dialog failed after the bank was already asked for a " +
        "TAN. Not retrying to avoid a duplicate push. Details: " +
        (err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Warm-start path. One synchronize() call against a config built from
 * the cached bankingInformation. Decoupled-TAN polling kicks in if the
 * bank still wants approval; coupled TAN bubbles up to the UI.
 *
 * Throws on transport errors so the caller can fall back to cold init.
 */
async function runWarmSync(
  bankcontact: typeof financeBankcontact.$inferSelect,
  pin: string,
  cachedBi: Record<string, unknown>,
  tanMethodId: number,
  factory: FintsClientFactory,
  sleep: (ms: number) => Promise<void>,
): Promise<DialogResult> {
  const config = FinTSConfig.fromBankingInformation(
    productId(),
    productVersion(),
    cachedBi as unknown as BankingInformation,
    bankcontact.login,
    pin,
    tanMethodId,
  );
  const client = factory(config);
  const response = await client.synchronize();
  const finalResponse = await pollDecoupledIfNeeded(client, response, sleep);
  const mapped = mapResponse(finalResponse, client.config.bankingInformation);
  if (mapped.state === "idle") mapped.client = client;
  return mapped;
}

/**
 * Replace the cached bankingInformation on a bankcontact. Called after
 * any successful FinTS dialog so the next sync hits the warm path.
 */
async function persistBankingInformation(
  bankcontactId: number,
  bi: BankingInformation,
): Promise<void> {
  await db
    .update(financeBankcontact)
    .set({ banking_information: bi as unknown as Record<string, unknown> })
    .where(eq(financeBankcontact.id, bankcontactId));
}

/**
 * Drop the cached bankingInformation. Called when credentials change
 * (PIN updates) since the bank may invalidate the systemId tied to
 * the old PIN, and a stale cache would just produce wrong-PIN-style
 * errors on the next warm sync.
 */
export async function clearBankingInformationCache(
  bankcontactId: number,
): Promise<void> {
  await db
    .update(financeBankcontact)
    .set({ banking_information: null })
    .where(eq(financeBankcontact.id, bankcontactId));
}

/**
 * If the current FinTS response demands a TAN *and* the selected
 * method is decoupled, waits for the user's device-side approval by
 * polling `synchronizeWithTan(ref)` (no TAN) according to the bank-
 * supplied cadence (`decoupled.waitingSeconds…`, `maxStatusRequests`).
 *
 * Returns the last SynchronizeResponse, which the caller maps via
 * mapResponse() exactly as if it had come straight from the initial
 * synchronize() — so a successful decoupled approval becomes
 * state="idle" and a timeout becomes state="tan-required" (with no
 * tanReference persisted — there is no user-typed TAN to collect).
 *
 * Coupled methods (chipTAN, SMS etc.) return `response` unchanged;
 * those still flow through the UI's TanDialog.
 */
async function pollDecoupledIfNeeded(
  client: FintsClientSurface,
  response: import("lib-fints").SynchronizeResponse,
  sleep: (ms: number) => Promise<void>,
): Promise<import("lib-fints").SynchronizeResponse> {
  if (!response.requiresTan) return response;
  const selected = client.config.selectedTanMethod;
  if (!selected?.isDecoupled || !selected.decoupled) return response;
  const ref = response.tanReference;
  if (!ref) return response;

  const d = selected.decoupled;
  await sleep((d.waitingSecondsBeforeFirstStatusRequest ?? 0) * 1000);

  let latest = await client.synchronizeWithTan(ref);
  let polls = 1;
  while (
    latest.requiresTan
    && polls < (d.maxStatusRequests ?? 1)
  ) {
    await sleep((d.waitingSecondsBetweenStatusRequests ?? 0) * 1000);
    latest = await client.synchronizeWithTan(ref);
    polls++;
  }
  return latest;
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
  const label = buildAccountLabel(account, accountKind);

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

/**
 * Human-readable label for an account snapshot, surfaced in the
 * bankcontact's "Noch nicht zugeordnete Bank-Konten" block and used
 * as the default label when the user imports the snapshot as a new
 * finance_account. Strategy:
 *
 *   1. A bank-supplied `product` name ("Girokonto Plus") wins.
 *   2. Otherwise the German kind label derived from the account type
 *      ("Giro", "Tagesgeld", …) — not the raw English enum.
 *   3. Appended: "– <Kontoinhaber>" when the bank returned one.
 *
 * Uses `||` fallbacks (not `??`) so empty strings don't leak
 * through — lib-fints does emit `""` for absent fields on some
 * banks, which previously collapsed the label down to just the
 * account number.
 */
function buildAccountLabel(
  account: RawBankAccount,
  accountKind: string,
): string {
  const product = account.product?.trim() || "";
  const typeLabel = product || GERMAN_KIND_LABEL[accountKind] || "Konto";
  const holder = account.holder1?.trim() || "";
  const suffix = holder ? ` – ${holder}` : "";
  return `${typeLabel} ${account.accountNumber}${suffix}`.trim();
}

const GERMAN_KIND_LABEL: Record<string, string> = {
  giro: "Girokonto",
  tagesgeld: "Tagesgeld",
  festgeld: "Festgeld",
  kredit: "Kredit",
  depot: "Depot",
  bausparen: "Bausparen",
  kreditkarte: "Kreditkarte",
  sonstige: "Konto",
};

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
