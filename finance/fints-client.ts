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
    from?: Date,
    to?: Date,
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
  canGetCreditCardStatements(accountNumber?: string): boolean;
  getCreditCardStatements(
    accountNumber: string,
    from?: Date,
  ): Promise<import("lib-fints").StatementResponse & {
    balance?: { balance: number; date: Date; currency: string };
    statements?: Array<{
      transactionDate: Date;
      valueDate: Date;
      currency: string;
      amount: number;
      purpose: string;
      originalCurrency: string;
      originalAmount: number;
      exchangeRate: number;
    }>;
  }>;
  getCreditCardStatementsWithTan(
    tanReference: string,
    tan?: string,
  ): Promise<import("lib-fints").StatementResponse & {
    balance?: { balance: number; date: Date; currency: string };
    statements?: Array<{
      transactionDate: Date;
      valueDate: Date;
      currency: string;
      amount: number;
      purpose: string;
      originalCurrency: string;
      originalAmount: number;
      exchangeRate: number;
    }>;
  }>;
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
/**
 * Process-level cache of live FinTSClient instances, keyed by
 * bankcontact id. Mirrors Finanzkraft's #fintsInstance singleton:
 * once the bank has accepted our SCA on a given client, we keep that
 * client around and reuse it for follow-up syncs / statement
 * fetches. The bank sees a continuing dialog (no fresh systemId, no
 * fresh authenticate) and — for read-only operations within PSD2's
 * 90-day window — lets us through without another TAN push.
 *
 * TTL bounds the leak: a long-idle entry is evicted on the next
 * lookup so we don't keep open dialogs forever and the bank can
 * garbage-collect its side too.
 *
 * Lost on container restart, which is fine — the warm path then
 * rebuilds the client from the persisted bankingInformation, also
 * usually without a TAN.
 */
interface CachedClientEntry {
  client: FintsClientSurface;
  expiresAt: number;
}
const liveClientCache = new Map<number, CachedClientEntry>();
const LIVE_CLIENT_TTL_MS = 30 * 60_000; // 30 min — covers human follow-ups

/**
 * Public read-side of the in-memory client cache. Used by the
 * mid-fetch resume path in tan-sessions.complete to grab the same
 * live client that paused for the TAN — so we can continue the
 * dialog with `getAccountStatementsWithTan(ref, tan)` instead of
 * starting a fresh init dialog (which would trigger a new TAN).
 *
 * Returns null if the entry has expired or never existed; the
 * caller surfaces that as state="error" so the UI prompts the user
 * to retrigger sync.
 */
export function takeCachedClient(bankcontactId: number): FintsClientSurface | null {
  const entry = liveClientCache.get(bankcontactId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    liveClientCache.delete(bankcontactId);
    return null;
  }
  // Refresh the TTL on access — active use keeps it alive.
  entry.expiresAt = Date.now() + LIVE_CLIENT_TTL_MS;
  return entry.client;
}

function rememberClient(
  bankcontactId: number,
  client: FintsClientSurface,
): void {
  liveClientCache.set(bankcontactId, {
    client,
    expiresAt: Date.now() + LIVE_CLIENT_TTL_MS,
  });
}

/**
 * Drop a client from the in-memory cache. Used after credential
 * changes, bankcontact deletions, or any branch where the cached
 * client would no longer represent a valid bank-side session.
 */
export function evictCachedClient(bankcontactId: number): void {
  liveClientCache.delete(bankcontactId);
}

/**
 * Test hook: clear every cached client. Tests that build a fresh
 * mock client per case need this to avoid leaks between cases.
 */
export function __resetFintsClientCacheForTests(): void {
  liveClientCache.clear();
}

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

  // ── Hot path: in-memory cached client ─────────────────────────────
  // Skipped for resume (the user just typed a TAN, the request has
  // an explicit bankingInformation that may differ from our cache)
  // and when a test injected its own clientFactory (those tests
  // expect their factory to actually run).
  if (!isResume && !opts.clientFactory) {
    const cached = takeCachedClient(bankcontactId);
    if (cached) {
      console.log(
        `[fints] hot-cache hit for bankcontact=${bankcontactId} — ` +
          `reusing live client, no synchronize() roundtrip`,
      );
      return {
        state: "idle",
        client: cached,
        bankingInformation: cached.config.bankingInformation as unknown as Record<string, unknown>,
      };
    }
  }

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
      rememberClient(bankcontactId, result.client as FintsClientSurface);
      console.log(
        `[fints] resume sync ok for bankcontact=${bankcontactId}, ` +
          `bankingInformation cached for next warm-start, ` +
          `live client cached for hot-path reuse`,
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
        rememberClient(bankcontactId, warm.client as FintsClientSurface);
        console.log(
          `[fints] warm sync ok for bankcontact=${bankcontactId} ` +
            `(no TAN required), bankingInformation refreshed, ` +
            `live client cached for hot-path reuse`,
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
      rememberClient(bankcontactId, client);
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
/**
 * Generic decoupled-TAN poll loop. Used by every operation that can
 * trigger a pushTAN approval (synchronize, getAccountStatements,
 * getAccountBalance, …). The continuation `withTan(ref)` is whatever
 * the operation's `…WithTan(ref)` counterpart is, called without a
 * user-supplied code (decoupled methods derive the approval from the
 * separate device).
 *
 * Returns the final response. If the bank still wants TAN after the
 * `maxStatusRequests` budget, that's surfaced as the un-approved
 * response (callers map it to "tan-required" / soft error). Coupled
 * methods (chipTAN, SMS, …) return the initial response unchanged —
 * those still need a real TAN from the user.
 */
async function pollDecoupled<
  T extends {
    requiresTan: boolean;
    success?: boolean;
    tanReference?: string;
  },
>(
  client: FintsClientSurface,
  initial: T,
  withTan: (ref: string) => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  if (!initial.requiresTan) return initial;
  const selected = client.config.selectedTanMethod;
  if (!selected?.isDecoupled || !selected.decoupled) return initial;
  const ref = initial.tanReference;
  if (!ref) return initial;

  const d = selected.decoupled;
  await sleep((d.waitingSecondsBeforeFirstStatusRequest ?? 0) * 1000);

  let latest = await withTan(ref);
  let polls = 1;
  while (latest.requiresTan && polls < (d.maxStatusRequests ?? 1)) {
    await sleep((d.waitingSecondsBetweenStatusRequests ?? 0) * 1000);
    latest = await withTan(ref);
    polls++;
  }
  return latest;
}

/**
 * Thin wrapper used by the synchronize() paths.
 */
async function pollDecoupledIfNeeded(
  client: FintsClientSurface,
  response: import("lib-fints").SynchronizeResponse,
  sleep: (ms: number) => Promise<void>,
): Promise<import("lib-fints").SynchronizeResponse> {
  return pollDecoupled(
    client,
    response,
    (ref) => client.synchronizeWithTan(ref),
    sleep,
  );
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
 * Linked-only fetch: when `opts.linkedAccountNumbers` is set, we
 * only call getAccountStatements / getAccountBalance for bank-side
 * accounts whose `accountNumber` is in that set. Unlinked accounts
 * still appear in the result (so persistFetchResult can offer them
 * up as "noch nicht zugeordnete Konten" in the UI), just without
 * statements / balance — and crucially without the per-account
 * SCA push that would otherwise hit the user's phone for accounts
 * they don't even want in fk-encore.
 *
 * Mid-flight decoupled TAN: PSD2's SCA rules let the bank demand a
 * fresh approval per "Umsatzabfrage" (statement query), independently
 * of the init-dialog TAN. When `getAccountStatements` (or
 * `getAccountBalance`) comes back with `requiresTan=true` *and* the
 * selected method is decoupled (pushTAN, BestSign, …), we poll the
 * `…WithTan(ref)` continuation until the user approves on their
 * device or the bank's `maxStatusRequests` budget is spent. For
 * coupled methods (chipTAN/SMS) we still record the soft error and
 * leave the per-account data missing — the UI doesn't yet have a
 * mid-fetch TAN dialog.
 */
export interface RunFetchOptions {
  /**
   * lib-fints accountNumbers of bank-side accounts that are linked
   * to a finance_account. Only these get the heavy statements +
   * balance calls. When omitted (e.g. legacy callers), every
   * bank-side account is fetched — original behaviour.
   */
  linkedAccountNumbers?: ReadonlySet<string>;
  /**
   * Per-account "fetch transactions starting from" date. The caller
   * (statements.fetchAndPersist) builds this from
   *   max(latest finance_transaction.booking_date for the account) - overlap
   * so re-syncs only ask the bank for new bookings (deduped via
   * finance_transaction.dedupe_hash). Accounts with no entry get a
   * configurable default — typically `new Date(now - 90 days)` to
   * cover PSD2's read-only window.
   *
   * Without these, comdirect & friends sometimes return arbitrary
   * archival data (years-old transactions instead of the latest
   * ones), because each bank picks its own "default" range when
   * none is specified.
   */
  fromByAccountNumber?: ReadonlyMap<string, Date>;
  /** Fallback `from` for accounts not in the map. */
  defaultFrom?: Date;
  sleep?: (ms: number) => Promise<void>;
}

export async function runFetchAccounts(
  client: FintsClientSurface,
  optsOrSleep:
    | RunFetchOptions
    | ((ms: number) => Promise<void>) = {},
): Promise<FetchResult> {
  // Back-compat: callers used to pass `sleep` directly as the second
  // arg. Detect a function and rewrap.
  const opts: RunFetchOptions = typeof optsOrSleep === "function"
    ? { sleep: optsOrSleep }
    : optsOrSleep;
  const sleep = opts.sleep ?? defaultSleep;

  const bi = client.config.bankingInformation;
  const accounts =
    (bi as unknown as {
      upd?: { bankAccounts?: RawBankAccount[] };
    }).upd?.bankAccounts ?? [];

  const snapshots: FintsAccountSnapshot[] = [];
  let partial = false;
  // Some banks (e.g. comdirect) report the same accountNumber twice
  // in upd.bankAccounts with different subAccountIds (giro + Visa
  // sub-account on the same number). lib-fints' getAccountStatements
  // / getAccountBalance only take the accountNumber, so a second
  // call would just retrigger the same SCA push for the same data.
  // Dedupe at this layer.
  const seenAccountNumbers = new Set<string>();
  const dedupedAccounts: RawBankAccount[] = [];
  for (const account of accounts) {
    if (seenAccountNumbers.has(account.accountNumber)) {
      console.log(
        `[fints] skipping duplicate bank-side account ${account.accountNumber} ` +
          `(subAccountId=${account.subAccountId ?? "<none>"}) — ` +
          `lib-fints addresses by accountNumber only, no need to re-fetch`,
      );
      continue;
    }
    seenAccountNumbers.add(account.accountNumber);
    dedupedAccounts.push(account);
  }

  for (let i = 0; i < dedupedAccounts.length; i++) {
    const account = dedupedAccounts[i];
    const fetch = opts.linkedAccountNumbers
      ? opts.linkedAccountNumbers.has(account.accountNumber)
      : true;
    const from = fetch
      ? opts.fromByAccountNumber?.get(account.accountNumber) ?? opts.defaultFrom
      : undefined;
    const r = await fetchOneAccount(client, account, sleep, { fetch, from });
    if (r.snapshot.errors.length > 0) partial = true;
    snapshots.push(r.snapshot);

    if (r.pendingTan) {
      // Coupled TAN (photoTAN/chipTAN) demanded mid-fetch. Stop the
      // loop, hand the queue + the TAN info back to the caller; the
      // resume path picks up from `account.accountNumber` after the
      // user submits.
      const remaining = dedupedAccounts
        .slice(i + 1)
        .map((a) => a.accountNumber);
      return {
        accounts: snapshots,
        partial: true,
        pendingTan: {
          ...r.pendingTan,
          accountNumber: account.accountNumber,
          remainingAccountNumbers: remaining,
        },
      };
    }
  }

  return { accounts: snapshots, partial };
}

interface RawBankAccount {
  accountNumber: string;
  /** Lib-fints includes the FinTS sub-account discriminator. We don't
   *  use it for routing (getAccountStatements doesn't take it), but
   *  log it so duplicate-accountNumber cases are diagnosable. */
  subAccountId?: string;
  iban?: string;
  currency?: string;
  accountType?: string;
  holder1?: string;
  product?: string;
}

interface FetchOneResult {
  snapshot: FintsAccountSnapshot;
  /**
   * Set when the per-account statements call hit a coupled-TAN
   * (photoTAN, chipTAN, …) that the decoupled-poll helper can't
   * unblock. The runFetchAccounts loop stops, the caller persists a
   * tan_session row of kind="statements", returns "tan-required" to
   * the UI, and resumes via tan-sessions.complete after the user
   * submits the TAN.
   */
  pendingTan?: {
    tanReference: string;
    tanChallenge?: string;
    tanMediaName?: string;
    tanPhotoMime?: string;
    tanPhotoBase64?: string;
  };
}

async function fetchOneAccount(
  client: FintsClientSurface,
  account: RawBankAccount,
  sleep: (ms: number) => Promise<void>,
  opts: { fetch: boolean; from?: Date } = { fetch: true },
): Promise<FetchOneResult> {
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

  // Unlinked accounts: return metadata only. The persist layer will
  // route them into stats.unknown so the UI can offer link / import.
  // No statements / balance call → no per-account SCA push.
  if (!opts.fetch) {
    return { snapshot };
  }

  // Use the dedicated credit-card FinTS transaction (DKKKU) for
  // kreditkarte accounts when the bank supports it. This returns
  // CreditCardStatement objects which carry original-currency fields
  // and are structured differently from MT940/CAMT statements.
  const isCreditCard = accountKind === "kreditkarte";
  const useCreditCardPath =
    isCreditCard &&
    typeof client.canGetCreditCardStatements === "function" &&
    client.canGetCreditCardStatements(account.accountNumber);

  try {
    let stmtResp;
    if (useCreditCardPath) {
      console.log(
        `[fints] credit-card statements ${account.accountNumber}` +
          (opts.from ? `: from=${opts.from.toISOString().slice(0, 10)}` : ""),
      );
      stmtResp = await client.getCreditCardStatements(
        account.accountNumber,
        opts.from,
      );
    } else if (opts.from) {
      console.log(
        `[fints] statements ${account.accountNumber}: from=` +
          opts.from.toISOString().slice(0, 10),
      );
      stmtResp = await client.getAccountStatements(
        account.accountNumber,
        opts.from,
      );
    } else {
      stmtResp = await client.getAccountStatements(account.accountNumber);
    }
    // Bank requires SCA for the statement query? Poll the decoupled
    // continuation until the user approves on their device, then
    // continue as if the first call had succeeded.
    if (stmtResp.requiresTan) {
      console.log(
        `[fints] statements ${account.accountNumber} → tan-required, ` +
          `polling decoupled approval`,
      );
      stmtResp = await pollDecoupled(
        client,
        stmtResp,
        useCreditCardPath
          ? (ref) => client.getCreditCardStatementsWithTan(ref)
          : (ref) => client.getAccountStatementsWithTan(ref),
        sleep,
      );
    }
    if (stmtResp.requiresTan) {
      // Coupled method (photoTAN/chipTAN/SMS) or decoupled-poll
      // exhausted its budget. Hand the TAN info up — the runFetch
      // loop stops here and the caller persists a session.
      const ref = stmtResp.tanReference;
      if (!ref) {
        snapshot.errors.push("statements-tan-required-no-ref");
        return { snapshot };
      }
      console.log(
        `[fints] statements ${account.accountNumber} → coupled-TAN, ` +
          `pausing fetch loop, returning to UI`,
      );
      return {
        snapshot,
        pendingTan: {
          tanReference: ref,
          tanChallenge: stmtResp.tanChallenge,
          tanMediaName: stmtResp.tanMediaName,
          tanPhotoMime: stmtResp.tanPhoto?.mimeType,
          tanPhotoBase64: stmtResp.tanPhoto
            ? Buffer.from(stmtResp.tanPhoto.image).toString("base64")
            : undefined,
        },
      };
    } else if (!stmtResp.success) {
      const first = stmtResp.bankAnswers.find((a) => a.code !== 0);
      snapshot.errors.push(
        `statements-error:${first?.code ?? "unknown"} ${first?.text ?? ""}`.trim(),
      );
    } else if (useCreditCardPath) {
      const ccStmt = stmtResp as typeof stmtResp & {
        statements?: Array<{
          transactionDate: Date; valueDate: Date; currency: string;
          amount: number; purpose: string; originalCurrency: string;
          originalAmount: number; exchangeRate: number;
        }>;
        balance?: { balance: number; date: Date; currency: string };
      };
      snapshot.transactions = mapCreditCardStatements(ccStmt.statements ?? []);
      // Credit card response also carries the current balance.
      if (ccStmt.balance) {
        snapshot.balance = {
          asOf: toIsoDate(ccStmt.balance.date),
          amount: toAmountString(ccStmt.balance.balance),
          currency: ccStmt.balance.currency || currency,
        };
      }
    } else {
      snapshot.transactions = mapStatements(stmtResp.statements ?? [], currency);
    }
  } catch (err) {
    snapshot.errors.push(
      `statements-exception:${(err as Error).message ?? String(err)}`,
    );
  }

  // Credit card path already populates balance from getCreditCardStatements.
  // Skip the separate HKSAL balance call to avoid a potential error.
  if (useCreditCardPath && snapshot.balance) {
    return { snapshot };
  }

  try {
    let balResp = await client.getAccountBalance(account.accountNumber);
    if (balResp.requiresTan) {
      console.log(
        `[fints] balance ${account.accountNumber} → tan-required, ` +
          `polling decoupled approval`,
      );
      balResp = await pollDecoupled(
        client,
        balResp,
        (ref) => client.getAccountBalanceWithTan(ref),
        sleep,
      );
    }
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

  return { snapshot };
}

/**
 * Resume a mid-fetch dialog after the user submitted a TAN. The
 * caller (tan-sessions.complete with kind="statements") has the live
 * client cached and the fetch_context that records the
 * `currentAccountNumber` we paused on plus the queue of accounts
 * waiting behind it.
 *
 * Steps:
 *   1. continue the paused statements call via
 *      getAccountStatementsWithTan(ref, tan).
 *   2. if the bank returns *another* TAN challenge (wrong TAN, or
 *      bank wants a follow-up): bubble back as { pendingTan } so the
 *      caller can refresh the session row and re-prompt.
 *   3. on success: process the statements + the per-account balance
 *      for the current account, then continue the loop with the
 *      remaining accounts via runFetchAccounts-style iteration.
 */
export async function resumeFetchAfterTan(
  client: FintsClientSurface,
  ctx: {
    tanReference: string;
    tan?: string;
    currentAccountNumber: string;
    remainingAccountNumbers: string[];
  },
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<FetchResult> {
  const bi = client.config.bankingInformation as unknown as {
    upd?: { bankAccounts?: RawBankAccount[] };
  };
  const allAccounts = bi.upd?.bankAccounts ?? [];

  // Find the bank account record for the paused accountNumber so we
  // can build a snapshot with the right metadata (label/kind/iban).
  const currentAccount = allAccounts.find(
    (a) => a.accountNumber === ctx.currentAccountNumber,
  );
  if (!currentAccount) {
    return {
      accounts: [],
      partial: true,
    };
  }

  const accountKind = mapAccountKind(currentAccount.accountType);
  const currency = currentAccount.currency ?? "EUR";
  const snapshot: FintsAccountSnapshot = {
    accountNumber: currentAccount.accountNumber,
    iban: currentAccount.iban ?? null,
    accountKind,
    currency,
    label: buildAccountLabel(currentAccount, accountKind),
    balance: null,
    transactions: [],
    errors: [],
  };

  const isCCResume =
    accountKind === "kreditkarte" &&
    typeof client.canGetCreditCardStatements === "function" &&
    client.canGetCreditCardStatements(currentAccount.accountNumber);

  let stmtResp;
  try {
    stmtResp = isCCResume
      ? await client.getCreditCardStatementsWithTan(ctx.tanReference, ctx.tan)
      : await client.getAccountStatementsWithTan(ctx.tanReference, ctx.tan);
  } catch (err) {
    snapshot.errors.push(
      `statements-exception:${(err as Error).message ?? String(err)}`,
    );
    return { accounts: [snapshot], partial: true };
  }

  // Decoupled fall-through (e.g. user took too long but the bank now
  // accepts a polled status check).
  if (stmtResp.requiresTan) {
    stmtResp = await pollDecoupled(
      client,
      stmtResp,
      isCCResume
        ? (ref) => client.getCreditCardStatementsWithTan(ref)
        : (ref) => client.getAccountStatementsWithTan(ref),
      sleep,
    );
  }
  if (stmtResp.requiresTan) {
    // Bank still wants another TAN — could be wrong TAN or chained
    // SCA. Bubble back so the session refreshes with the new
    // challenge / photo.
    const ref = stmtResp.tanReference;
    if (!ref) {
      snapshot.errors.push("statements-tan-required-no-ref");
      return { accounts: [snapshot], partial: true };
    }
    return {
      accounts: [snapshot],
      partial: true,
      pendingTan: {
        tanReference: ref,
        tanChallenge: stmtResp.tanChallenge,
        tanMediaName: stmtResp.tanMediaName,
        tanPhotoMime: stmtResp.tanPhoto?.mimeType,
        tanPhotoBase64: stmtResp.tanPhoto
          ? Buffer.from(stmtResp.tanPhoto.image).toString("base64")
          : undefined,
        accountNumber: ctx.currentAccountNumber,
        remainingAccountNumbers: ctx.remainingAccountNumbers,
      },
    };
  }
  if (!stmtResp.success) {
    const first = stmtResp.bankAnswers.find((a) => a.code !== 0);
    snapshot.errors.push(
      `statements-error:${first?.code ?? "unknown"} ${first?.text ?? ""}`.trim(),
    );
  } else if (isCCResume) {
    const ccStmt = stmtResp as typeof stmtResp & {
      statements?: Array<{
        transactionDate: Date; valueDate: Date; currency: string;
        amount: number; purpose: string; originalCurrency: string;
        originalAmount: number; exchangeRate: number;
      }>;
      balance?: { balance: number; date: Date; currency: string };
    };
    snapshot.transactions = mapCreditCardStatements(ccStmt.statements ?? []);
    if (ccStmt.balance) {
      snapshot.balance = {
        asOf: toIsoDate(ccStmt.balance.date),
        amount: toAmountString(ccStmt.balance.balance),
        currency: ccStmt.balance.currency || currency,
      };
    }
  } else {
    snapshot.transactions = mapStatements(
      stmtResp.statements ?? [],
      currency,
    );
  }

  // Balance for the resumed account — typically already in the same
  // session, no fresh TAN.
  try {
    let balResp = await client.getAccountBalance(currentAccount.accountNumber);
    if (balResp.requiresTan) {
      balResp = await pollDecoupled(
        client,
        balResp,
        (ref) => client.getAccountBalanceWithTan(ref),
        sleep,
      );
    }
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

  // Resume the loop with the queued accounts. Each one is a fresh
  // getAccountStatements call on the same client; if the bank
  // demands TAN again, fetchOneAccount returns pendingTan as before.
  const snapshots: FintsAccountSnapshot[] = [snapshot];
  let partial = snapshot.errors.length > 0;
  for (let i = 0; i < ctx.remainingAccountNumbers.length; i++) {
    const acn = ctx.remainingAccountNumbers[i];
    const acc = allAccounts.find((a) => a.accountNumber === acn);
    if (!acc) continue;
    const r = await fetchOneAccount(client, acc, sleep, { fetch: true });
    if (r.snapshot.errors.length > 0) partial = true;
    snapshots.push(r.snapshot);
    if (r.pendingTan) {
      const remaining = ctx.remainingAccountNumbers.slice(i + 1);
      return {
        accounts: snapshots,
        partial: true,
        pendingTan: {
          ...r.pendingTan,
          accountNumber: acn,
          remainingAccountNumbers: remaining,
        },
      };
    }
  }

  return { accounts: snapshots, partial };
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

function mapCreditCardStatements(
  statements: Array<{
    transactionDate: Date;
    valueDate: Date;
    currency: string;
    amount: number;
    purpose: string;
    originalCurrency: string;
    originalAmount: number;
    exchangeRate: number;
  }>,
): FintsTransactionData[] {
  return statements.map((s) => {
    const isForeignCurrency =
      s.originalCurrency &&
      s.originalCurrency !== s.currency &&
      s.originalAmount !== 0;
    return {
      bookingDate: toIsoDate(s.transactionDate),
      valueDate: toIsoDate(s.valueDate),
      amount: toAmountString(s.amount),
      currency: s.currency,
      purpose: s.purpose?.trim() || null,
      counterparty: null,
      counterpartyIban: null,
      bankRef: null,
      originalAmount: isForeignCurrency ? toAmountString(s.originalAmount) : null,
      originalCurrency: isForeignCurrency ? s.originalCurrency : null,
      exchangeRate: isForeignCurrency && s.exchangeRate
        ? s.exchangeRate.toFixed(6)
        : null,
      raw: s as unknown as Record<string, unknown>,
    };
  });
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
        bankRef: t.bankReference?.trim() || null,
        originalAmount: null,
        originalCurrency: null,
        exchangeRate: null,
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
    tanPhoto?: { mimeType: string; image: Uint8Array };
    bankAnswers: BankAnswer[];
  },
  bankingInformation: BankingInformation,
): DialogResult {
  if (response.requiresTan) {
    const photo = response.tanPhoto;
    return {
      state: "tan-required",
      bankingInformation: bankingInformation as unknown as Record<string, unknown>,
      tanChallenge: response.tanChallenge,
      tanReference: response.tanReference,
      tanMediaName: response.tanMediaName,
      tanPhotoMime: photo?.mimeType,
      tanPhotoBase64: photo
        ? Buffer.from(photo.image).toString("base64")
        : undefined,
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
