/**
 * PayPal connector for the finance module — Issue #427, Etappe 4.
 *
 * Mirrors `fints-client.ts` in spirit: a thin façade over the PayPal
 * REST APIs that the higher-level sync code (statements.ts / cron) can
 * call without knowing OAuth or HTTP details.
 *
 * Scope of this stage:
 *   - OAuth refresh-token flow: trade the user-bound refresh token for
 *     a fresh access token, cache it in `credentials_encrypted` so
 *     short bursts of sync activity don't redundantly hit /oauth2/token.
 *   - `/v1/reporting/balances`     → `PaypalBalance[]` (one per currency).
 *   - `/v1/reporting/transactions` → `PaypalTransaction[]`, paged.
 *
 * Out of scope for now (Etappe 5+):
 *   - The OAuth Authorization-Code start / callback / disconnect
 *     endpoints. They will populate `credentials_encrypted` with the
 *     initial PayPal bundle this connector then reuses.
 *   - Statement persistence / dedupe — handled in `statement-persist.ts`
 *     when Etappe 6 wires PayPal into the sync pipeline.
 *
 * Architecture: GitHub Issue #427, design memo §"Etappe 4".
 */

import { eq } from "drizzle-orm";
import { secret } from "encore.dev/config";

import db from "../db/database";
import { financeBankcontact } from "../db/schema";
import {
  decryptCredentialBundle,
  encryptCredentialBundle,
  type PaypalCredentials,
} from "./encryption";

console.log("[boot] finance/paypal-client.ts: all imports resolved");

// ---------------------------------------------------------------------------
// Encore secrets — Etappe 3.
//
// One pair per environment so a sandbox bankcontact authenticates
// against the sandbox PayPal app and a live one against production.
// `PaypalRedirectUri` is referenced here (rather than in the not-yet-
// existing paypal-oauth.ts) so operators can populate the full secret
// set in one go ahead of Etappe 5.
// ---------------------------------------------------------------------------

const paypalAppClientIdSandbox = secret("PaypalAppClientIdSandbox");
const paypalAppClientSecretSandbox = secret("PaypalAppClientSecretSandbox");
const paypalAppClientIdLive = secret("PaypalAppClientIdLive");
const paypalAppClientSecretLive = secret("PaypalAppClientSecretLive");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _paypalRedirectUri = secret("PaypalRedirectUri");

export type PaypalEnvironment = "sandbox" | "live";

const PAYPAL_BASE_URLS: Record<PaypalEnvironment, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

/**
 * Access tokens last around nine hours. We refresh just before the
 * official cutoff so a long-running sync that started right under the
 * wire still completes with a valid token, without an extra DB
 * round-trip mid-call.
 */
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Test seam matching the global `fetch` shape we actually use. Kept
 * narrower than `typeof fetch` so test fakes don't have to satisfy
 * the AbortSignal / referrer corners of the Web spec.
 */
export type PaypalFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Test seams. All optional — production passes none. */
export interface PaypalClientOptions {
  fetcher?: PaypalFetcher;
  /** Clock override; defaults to `Date.now()`. */
  now?: () => number;
  /**
   * Persist callback for refreshed token bundles. Production writes
   * the new bundle into `finance_bankcontact.credentials_encrypted`;
   * tests override this to capture the call without DB writes.
   */
  persistTokens?: (
    bankcontactId: number,
    creds: PaypalCredentials,
  ) => Promise<void>;
}

export interface PaypalBalance {
  /** ISO 4217 currency code, e.g. "EUR". */
  currency: string;
  /** Decimal string for the full balance (incl. holds). */
  total: string;
  /** Decimal string for the spendable subset. */
  available: string;
  /** True for the wallet's primary balance. PayPal returns at most one per wallet. */
  primary: boolean;
  /** ISO-8601 timestamp from the response (`as_of_time`). */
  asOf: string;
}

export interface PaypalTransaction {
  /** PayPal-side transaction id. Stable and unique — used as `dedupe_hash`. */
  transactionId: string;
  /** ISO-8601 initiation timestamp (mapped to bookingDate). */
  bookingDate: string;
  /** ISO-8601 updated timestamp; null if PayPal didn't return one. */
  valueDate: string | null;
  /** Signed decimal string. Negative for outflows, positive for inflows. */
  amount: string;
  /** ISO 4217. */
  currency: string;
  /** Subject + note joined with " — ", null when both empty. */
  purpose: string | null;
  /** Counterparty display name from `payer_info.payer_name`; null if absent. */
  counterparty: string | null;
  /** Counterparty PayPal e-mail address, if returned. */
  counterpartyEmail: string | null;
  /** PayPal event code (e.g. "T0006"). Useful for downstream classification. */
  eventCode: string | null;
  /** PayPal status — "S" (success), "P" (pending), "D" (denied), … */
  status: string | null;
  /** Verbatim PayPal `transaction_details` element for forensic JSONB storage. */
  raw: Record<string, unknown>;
}

export class PaypalClientError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaypalClientError";
  }
}

// ---------------------------------------------------------------------------
// Bankcontact loading
// ---------------------------------------------------------------------------

/**
 * PayPal-specific narrowing of the bankcontact row. With Issue #427 the
 * row's FinTS columns may be null and the PayPal ones non-null.
 */
export type PaypalBankcontactRow = typeof financeBankcontact.$inferSelect & {
  paypal_environment: PaypalEnvironment;
};

/**
 * Load a bankcontact row and assert it is configured for PayPal. Mirrors
 * `loadBankcontact` in fints-client.ts but with the PayPal guard.
 */
export async function loadPaypalBankcontact(
  id: number,
): Promise<PaypalBankcontactRow> {
  const rows = await db
    .select()
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new PaypalClientError(
      "not_found",
      `finance_bankcontact ${id} not found`,
    );
  }
  return assertPaypalBankcontact(row);
}

function assertPaypalBankcontact(
  row: typeof financeBankcontact.$inferSelect,
): PaypalBankcontactRow {
  if (row.access_type !== "paypal") {
    throw new PaypalClientError(
      "wrong_access_type",
      `bankcontact ${row.id} has access_type="${row.access_type}", expected "paypal"`,
    );
  }
  if (row.paypal_environment !== "sandbox" && row.paypal_environment !== "live") {
    throw new PaypalClientError(
      "missing_environment",
      `bankcontact ${row.id} is PayPal but paypal_environment is "${row.paypal_environment}"`,
    );
  }
  return row as PaypalBankcontactRow;
}

// ---------------------------------------------------------------------------
// Token acquisition
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  refresh_token?: unknown;
}

/**
 * Returns a valid PayPal access token for the given bankcontact.
 *
 * Reuses the cached `accessToken` from `credentials_encrypted` if it
 * is still inside its expiry window (minus a leeway). Otherwise calls
 * PayPal's `/v1/oauth2/token` with the user-bound refresh token, then
 * persists the new access token back to the row so concurrent sync
 * requests share it.
 *
 * Throws `PaypalClientError("missing_refresh_token")` if the row has
 * never been connected via OAuth — the caller (Etappe 5 / 6) is the
 * one that walks the user through the connect flow.
 */
export async function getPaypalAccessToken(
  bankcontactId: number,
  options: PaypalClientOptions = {},
): Promise<string> {
  const row = await loadPaypalBankcontact(bankcontactId);
  return getPaypalAccessTokenForRow(row, options);
}

/**
 * Row-taking variant of {@link getPaypalAccessToken}. Used internally
 * by the fetch helpers (which already loaded the row) and by tests
 * that want to skip the DB load.
 */
export async function getPaypalAccessTokenForRow(
  row: PaypalBankcontactRow,
  options: PaypalClientOptions = {},
): Promise<string> {
  if (!row.credentials_encrypted) {
    throw new PaypalClientError(
      "missing_credentials",
      `bankcontact ${row.id}: no PayPal credentials stored yet`,
    );
  }
  const bundle = decryptCredentialBundle(row.credentials_encrypted);
  if (bundle.kind !== "paypal") {
    throw new PaypalClientError(
      "wrong_credentials_kind",
      `bankcontact ${row.id}: credentials are kind="${bundle.kind}", expected "paypal"`,
    );
  }

  const now = options.now ? options.now() : Date.now();

  // Hot path: cached token still fresh.
  if (
    bundle.accessToken
    && bundle.accessTokenExpiresAt
    && Date.parse(bundle.accessTokenExpiresAt) - TOKEN_REFRESH_LEEWAY_MS > now
  ) {
    return bundle.accessToken;
  }

  if (!bundle.refreshToken) {
    throw new PaypalClientError(
      "missing_refresh_token",
      `bankcontact ${row.id}: PayPal connection is not authorised — ` +
        `refresh token absent, reconnect via the OAuth flow`,
    );
  }

  const refreshed = await refreshPaypalAccessToken(row, bundle.refreshToken, options);

  const nextBundle: PaypalCredentials = {
    kind: "paypal",
    refreshToken: refreshed.refreshToken ?? bundle.refreshToken,
    accessToken: refreshed.accessToken,
    accessTokenExpiresAt: new Date(now + refreshed.expiresInMs).toISOString(),
  };
  await persistTokenBundle(row.id, nextBundle, options);
  return refreshed.accessToken;
}

interface RefreshedTokens {
  accessToken: string;
  /** PayPal sometimes rotates refresh tokens — keep the new one when present. */
  refreshToken: string | null;
  expiresInMs: number;
}

async function refreshPaypalAccessToken(
  row: PaypalBankcontactRow,
  refreshToken: string,
  options: PaypalClientOptions,
): Promise<RefreshedTokens> {
  const fetcher = options.fetcher ?? (globalThis.fetch as PaypalFetcher);
  const baseUrl = PAYPAL_BASE_URLS[row.paypal_environment];

  const { clientId, clientSecret } = getAppCredentials(row.paypal_environment);
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  let resp: Response;
  try {
    resp = await fetcher(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new PaypalClientError(
      "network",
      `PayPal token refresh network error: ${(err as Error).message ?? String(err)}`,
    );
  }

  if (!resp.ok) {
    const text = await readBodySafe(resp);
    throw new PaypalClientError(
      `http_${resp.status}`,
      `PayPal token refresh returned ${resp.status}: ${text}`,
    );
  }

  const json = (await resp.json()) as TokenResponse;
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new PaypalClientError(
      "malformed_token_response",
      "PayPal token refresh: response missing access_token",
    );
  }
  const expiresIn =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? Math.floor(json.expires_in)
      : 0;

  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresInMs: expiresIn * 1000,
  };
}

function getAppCredentials(env: PaypalEnvironment): {
  clientId: string;
  clientSecret: string;
} {
  const clientId =
    env === "sandbox" ? paypalAppClientIdSandbox() : paypalAppClientIdLive();
  const clientSecret =
    env === "sandbox"
      ? paypalAppClientSecretSandbox()
      : paypalAppClientSecretLive();
  if (!clientId || !clientSecret) {
    throw new PaypalClientError(
      "missing_app_credentials",
      `PayPal app credentials for "${env}" are not configured — ` +
        `set the PaypalAppClientId${env === "sandbox" ? "Sandbox" : "Live"} ` +
        `and matching secret`,
    );
  }
  return { clientId, clientSecret };
}

async function persistTokenBundle(
  bankcontactId: number,
  bundle: PaypalCredentials,
  options: PaypalClientOptions,
): Promise<void> {
  if (options.persistTokens) {
    await options.persistTokens(bankcontactId, bundle);
    return;
  }
  const blob = encryptCredentialBundle(bundle);
  await db
    .update(financeBankcontact)
    .set({ credentials_encrypted: blob })
    .where(eq(financeBankcontact.id, bankcontactId));
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

interface BalancesResponse {
  account_id?: unknown;
  as_of_time?: unknown;
  balances?: Array<{
    currency?: unknown;
    primary?: unknown;
    total_balance?: { currency_code?: unknown; value?: unknown };
    available_balance?: { currency_code?: unknown; value?: unknown };
  }>;
}

/**
 * Fetches the current balance list for a PayPal bankcontact. PayPal
 * returns one entry per held currency; the consumer (Etappe 6) writes
 * one row per entry into `finance_account_balance`.
 *
 * The `as_of_time` from the response is propagated onto every balance
 * so the persist layer doesn't have to decide a per-currency timestamp.
 */
export async function fetchPaypalBalances(
  bankcontactId: number,
  options: PaypalClientOptions = {},
): Promise<PaypalBalance[]> {
  const row = await loadPaypalBankcontact(bankcontactId);
  const token = await getPaypalAccessTokenForRow(row, options);
  const fetcher = options.fetcher ?? (globalThis.fetch as PaypalFetcher);
  const baseUrl = PAYPAL_BASE_URLS[row.paypal_environment];

  let resp: Response;
  try {
    resp = await fetcher(`${baseUrl}/v1/reporting/balances`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new PaypalClientError(
      "network",
      `PayPal balances network error: ${(err as Error).message ?? String(err)}`,
    );
  }
  if (!resp.ok) {
    const text = await readBodySafe(resp);
    throw new PaypalClientError(
      `http_${resp.status}`,
      `PayPal balances returned ${resp.status}: ${text}`,
    );
  }
  const json = (await resp.json()) as BalancesResponse;

  const asOf =
    typeof json.as_of_time === "string" ? json.as_of_time : new Date().toISOString();

  const out: PaypalBalance[] = [];
  for (const b of json.balances ?? []) {
    const currency =
      typeof b.currency === "string"
        ? b.currency
        : typeof b.total_balance?.currency_code === "string"
          ? b.total_balance.currency_code
          : null;
    if (!currency) continue;
    out.push({
      currency,
      total: typeof b.total_balance?.value === "string" ? b.total_balance.value : "0.00",
      available:
        typeof b.available_balance?.value === "string"
          ? b.available_balance.value
          : "0.00",
      primary: b.primary === true,
      asOf,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

interface TransactionsResponse {
  transaction_details?: Array<TransactionDetail>;
  total_pages?: unknown;
  page?: unknown;
}

interface TransactionDetail {
  transaction_info?: {
    transaction_id?: unknown;
    transaction_event_code?: unknown;
    transaction_initiation_date?: unknown;
    transaction_updated_date?: unknown;
    transaction_amount?: { currency_code?: unknown; value?: unknown };
    transaction_subject?: unknown;
    transaction_note?: unknown;
    transaction_status?: unknown;
  };
  payer_info?: {
    email_address?: unknown;
    payer_name?: {
      alternate_full_name?: unknown;
      given_name?: unknown;
      surname?: unknown;
    };
  };
}

/**
 * Fetches transactions for the given window from PayPal's reporting
 * API. PayPal pages at 500 rows; the helper follows `total_pages` so
 * the caller doesn't have to. Empty windows return `[]`.
 *
 * Caveat: PayPal's reporting API has a 31-day maximum window per call
 * and ~3h reporting latency. Etappe 6 (sync routing) takes care of
 * sliding the window — this layer is window-agnostic.
 */
export async function fetchPaypalTransactions(
  bankcontactId: number,
  startDate: Date,
  endDate: Date,
  options: PaypalClientOptions = {},
): Promise<PaypalTransaction[]> {
  const row = await loadPaypalBankcontact(bankcontactId);
  const token = await getPaypalAccessTokenForRow(row, options);
  const fetcher = options.fetcher ?? (globalThis.fetch as PaypalFetcher);
  const baseUrl = PAYPAL_BASE_URLS[row.paypal_environment];

  const out: PaypalTransaction[] = [];
  let page = 1;
  for (;;) {
    const url = new URL(`${baseUrl}/v1/reporting/transactions`);
    url.searchParams.set("start_date", startDate.toISOString());
    url.searchParams.set("end_date", endDate.toISOString());
    url.searchParams.set("fields", "all");
    url.searchParams.set("page_size", "500");
    url.searchParams.set("page", String(page));

    let resp: Response;
    try {
      resp = await fetcher(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new PaypalClientError(
        "network",
        `PayPal transactions network error: ${(err as Error).message ?? String(err)}`,
      );
    }
    if (!resp.ok) {
      const text = await readBodySafe(resp);
      throw new PaypalClientError(
        `http_${resp.status}`,
        `PayPal transactions returned ${resp.status}: ${text}`,
      );
    }
    const json = (await resp.json()) as TransactionsResponse;
    for (const detail of json.transaction_details ?? []) {
      const mapped = mapTransactionDetail(detail);
      if (mapped) out.push(mapped);
    }
    const totalPages = typeof json.total_pages === "number" ? json.total_pages : 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return out;
}

function mapTransactionDetail(
  detail: TransactionDetail,
): PaypalTransaction | null {
  const info = detail.transaction_info ?? {};
  const transactionId = typeof info.transaction_id === "string" ? info.transaction_id : "";
  if (!transactionId) return null;

  const amount =
    typeof info.transaction_amount?.value === "string"
      ? info.transaction_amount.value
      : "0.00";
  const currency =
    typeof info.transaction_amount?.currency_code === "string"
      ? info.transaction_amount.currency_code
      : "USD";

  const subject = typeof info.transaction_subject === "string" ? info.transaction_subject : null;
  const note = typeof info.transaction_note === "string" ? info.transaction_note : null;
  const purpose = joinPurpose(subject, note);

  const payer = detail.payer_info ?? {};
  const payerName = payer.payer_name ?? {};
  const counterparty =
    pickString(payerName.alternate_full_name)
    ?? joinName(pickString(payerName.given_name), pickString(payerName.surname));

  return {
    transactionId,
    bookingDate:
      typeof info.transaction_initiation_date === "string"
        ? info.transaction_initiation_date
        : "",
    valueDate:
      typeof info.transaction_updated_date === "string"
        ? info.transaction_updated_date
        : null,
    amount,
    currency,
    purpose,
    counterparty,
    counterpartyEmail: pickString(payer.email_address),
    eventCode: pickString(info.transaction_event_code),
    status: pickString(info.transaction_status),
    raw: detail as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function joinName(given: string | null, surname: string | null): string | null {
  if (given && surname) return `${given} ${surname}`;
  return given ?? surname;
}

function joinPurpose(
  subject: string | null,
  note: string | null,
): string | null {
  if (subject && note) return `${subject} — ${note}`;
  return subject ?? note;
}

async function readBodySafe(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    // PayPal error bodies tend to be JSON-ish — cap the length so a
    // pathological response doesn't blow the error message budget.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<unreadable body>";
  }
}
