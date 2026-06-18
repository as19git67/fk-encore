/**
 * PayPal OAuth Authorization-Code flow (Issue #427, Etappe 5).
 *
 * Three endpoints make up the connect flow:
 *
 *   POST /finance/bankcontacts/:id/paypal/start
 *     UI-triggered. Mints a CSRF state token, persists it scoped to
 *     bankcontact + user, returns the PayPal authorization URL the
 *     browser should redirect to.
 *
 *   GET  /finance/bankcontacts/paypal/callback
 *     PayPal redirects here after the user authorises. We exchange
 *     the code for tokens, persist the refresh token in the
 *     bankcontact's credential bundle, mint the matching
 *     finance_account row, and then 302 the browser back to the
 *     frontend's bankcontact detail view.
 *
 *   POST /finance/bankcontacts/:id/paypal/disconnect
 *     Wipes the stored tokens so the bankcontact is "disconnected" but
 *     keeps the finance_account + history intact.
 *
 * The callback is intentionally public (no auth header) because PayPal
 * does the redirect server-to-browser — it has no way to forward our
 * auth cookies. The `state` token provides CSRF protection.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { secret } from "encore.dev/config";
import { eq, lt } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountType,
  financeBankcontact,
  financePaypalOauthState,
} from "../db/schema";
import {
  decryptCredentialBundle,
  encryptCredentialBundle,
  type PaypalCredentials,
} from "./encryption";
import {
  type PaypalEnvironment,
  type PaypalFetcher,
} from "./paypal-client";

console.log("[boot] finance/paypal-oauth.ts: all imports resolved");

// ---------------------------------------------------------------------------
// Secrets (declared in paypal-client.ts too; both files reference the same
// names so an operator only sets them once via `encore secret set`).
// ---------------------------------------------------------------------------

const paypalAppClientIdSandbox = secret("PaypalAppClientIdSandbox");
const paypalAppClientSecretSandbox = secret("PaypalAppClientSecretSandbox");
const paypalAppClientIdLive = secret("PaypalAppClientIdLive");
const paypalAppClientSecretLive = secret("PaypalAppClientSecretLive");
const paypalRedirectUri = secret("PaypalRedirectUri");

const STATE_TTL_MS = 10 * 60_000;

const PAYPAL_AUTH_BASE: Record<PaypalEnvironment, string> = {
  sandbox: "https://www.sandbox.paypal.com",
  live: "https://www.paypal.com",
};
const PAYPAL_API_BASE: Record<PaypalEnvironment, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

/**
 * Scopes requested in the Authorization-Code flow. `openid` + `profile`
 * are required for PayPal to return a refresh_token (the reporting
 * scopes alone give an access_token only). `*.read` scopes match the
 * read-only nature of the connector.
 */
const PAYPAL_OAUTH_SCOPES =
  "openid profile " +
  "https://uri.paypal.com/services/reporting/balances.read " +
  "https://uri.paypal.com/services/reporting/search.read";

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:5173";

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

interface OAuthOptions {
  fetcher?: PaypalFetcher;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Start endpoint
// ---------------------------------------------------------------------------

interface StartParams {
  id: number;
}

interface StartResponse {
  auth_url: string;
  state: string;
  expires_at: string;
}

export const startPaypalConnect = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/bankcontacts/:id/paypal/start",
    auth: true,
  },
  async (p: StartParams): Promise<StartResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    return runStartPaypalConnect(p.id, Number(auth.userID));
  },
);

/**
 * Internal entry that the API handler and tests both call. Splitting
 * it out lets the test exercise the state-minting logic without
 * having to inject getAuthData.
 */
export async function runStartPaypalConnect(
  bankcontactId: number,
  userId: number,
): Promise<StartResponse> {
  const row = await loadBankcontact(bankcontactId);
  const env = assertPaypalEnvironment(row);

  // Drop any stale state rows for this bankcontact — at most one
  // start is in flight at a time and keeping older ones around just
  // bloats the cleanup index.
  await db
    .delete(financePaypalOauthState)
    .where(eq(financePaypalOauthState.bankcontact_id, bankcontactId));

  const state = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  await db.insert(financePaypalOauthState).values({
    state,
    bankcontact_id: bankcontactId,
    user_id: userId,
    environment: env,
    expires_at: expiresAt,
  });

  const { clientId } = getAppCredentials(env);
  const url = new URL(`${PAYPAL_AUTH_BASE[env]}/signin/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", PAYPAL_OAUTH_SCOPES);
  url.searchParams.set("redirect_uri", paypalRedirectUri());
  url.searchParams.set("state", state);

  return {
    auth_url: url.toString(),
    state,
    expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Callback endpoint (raw, public — PayPal redirects the user's browser here)
// ---------------------------------------------------------------------------

export const paypalCallback = api.raw(
  {
    expose: true,
    method: "GET",
    path: "/finance/bankcontacts/paypal/callback",
  },
  async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorCode = url.searchParams.get("error");

    try {
      if (!state) {
        respondWithError(res, "missing state parameter", null);
        return;
      }

      const stateRow = await db
        .select()
        .from(financePaypalOauthState)
        .where(eq(financePaypalOauthState.state, state))
        .limit(1);
      const found = stateRow[0];
      if (!found) {
        respondWithError(res, "unknown or expired state", null);
        return;
      }
      // One-shot: consume the state row regardless of outcome so a
      // replay can't reuse the same token.
      await db
        .delete(financePaypalOauthState)
        .where(eq(financePaypalOauthState.state, state));

      if (Date.parse(found.expires_at) < Date.now()) {
        respondWithError(res, "state expired", found.bankcontact_id);
        return;
      }

      if (errorCode) {
        respondWithError(res, `paypal: ${errorCode}`, found.bankcontact_id);
        return;
      }
      if (!code) {
        respondWithError(res, "missing code parameter", found.bankcontact_id);
        return;
      }

      await completeConnect(found.bankcontact_id, found.environment as PaypalEnvironment, code, {});
      respondWithSuccess(res, found.bankcontact_id);
    } catch (err) {
      console.error("[finance.paypal-oauth] callback failed:", err);
      respondWithError(res, (err as Error).message ?? "internal error", null);
    }
  },
);

/**
 * Test-callable variant of the callback's happy path. Skips the
 * raw-request plumbing so unit tests can drive the OAuth exchange +
 * persistence with a mocked fetcher.
 */
export async function completeConnect(
  bankcontactId: number,
  environment: PaypalEnvironment,
  code: string,
  options: OAuthOptions,
): Promise<void> {
  const tokens = await exchangeCodeForTokens(environment, code, options);
  const userInfo = await fetchPaypalUserInfo(environment, tokens.accessToken, options);

  const now = options.now ? options.now() : Date.now();
  const bundle: PaypalCredentials = {
    kind: "paypal",
    refreshToken: tokens.refreshToken ?? undefined,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: new Date(now + tokens.expiresInMs).toISOString(),
  };

  await db
    .update(financeBankcontact)
    .set({
      credentials_encrypted: encryptCredentialBundle(bundle),
      paypal_client_id: userInfo.payerId,
      last_sync_status: "ok",
    })
    .where(eq(financeBankcontact.id, bankcontactId));

  // First-time connect: mint the wallet's finance_account so the next
  // sync has a destination. The mapping is 1:1 (one wallet ↔ one
  // bankcontact ↔ one finance_account), so we use the bankcontact id
  // to detect the "already created" case.
  await ensurePaypalAccount(bankcontactId, userInfo.payerId);
}

// ---------------------------------------------------------------------------
// Disconnect endpoint
// ---------------------------------------------------------------------------

interface DisconnectParams {
  id: number;
}

interface DisconnectResponse {
  disconnected: true;
}

export const disconnectPaypal = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/bankcontacts/:id/paypal/disconnect",
    auth: true,
  },
  async (p: DisconnectParams): Promise<DisconnectResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    const row = await loadBankcontact(p.id);
    assertPaypalEnvironment(row);

    await db
      .update(financeBankcontact)
      .set({
        credentials_encrypted: null,
        last_sync_status: "disconnected",
      })
      .where(eq(financeBankcontact.id, p.id));

    return { disconnected: true };
  },
);

// ---------------------------------------------------------------------------
// Cleanup of expired state rows. Wired into the finance-tan-cleanup cron
// via statements-cron.ts so we don't add a second timer.
// ---------------------------------------------------------------------------

export async function cleanupExpiredPaypalOauthStates(): Promise<number> {
  const result = await db
    .delete(financePaypalOauthState)
    .where(lt(financePaypalOauthState.expires_at, new Date().toISOString()))
    .returning({ state: financePaypalOauthState.state });
  return result.length;
}

// ---------------------------------------------------------------------------
// PayPal HTTP calls
// ---------------------------------------------------------------------------

interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInMs: number;
}

async function exchangeCodeForTokens(
  environment: PaypalEnvironment,
  code: string,
  options: OAuthOptions,
): Promise<TokenExchangeResult> {
  const fetcher = options.fetcher ?? (globalThis.fetch as PaypalFetcher);
  const { clientId, clientSecret } = getAppCredentials(environment);
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: paypalRedirectUri(),
  });

  const resp = await fetcher(`${PAYPAL_API_BASE[environment]}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await readBodySafe(resp);
    throw new Error(`paypal token exchange returned ${resp.status}: ${text}`);
  }

  const json = (await resp.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("paypal token exchange: missing access_token");
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

interface UserInfo {
  payerId: string;
}

async function fetchPaypalUserInfo(
  environment: PaypalEnvironment,
  accessToken: string,
  options: OAuthOptions,
): Promise<UserInfo> {
  const fetcher = options.fetcher ?? (globalThis.fetch as PaypalFetcher);
  const url = `${PAYPAL_API_BASE[environment]}/v1/identity/openidconnect/userinfo?schema=openid`;
  const resp = await fetcher(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await readBodySafe(resp);
    throw new Error(`paypal userinfo returned ${resp.status}: ${text}`);
  }
  const json = (await resp.json()) as { payer_id?: unknown; user_id?: unknown };
  const payerId =
    typeof json.payer_id === "string" && json.payer_id.length > 0
      ? json.payer_id
      : typeof json.user_id === "string" && json.user_id.length > 0
        ? json.user_id
        : "";
  if (!payerId) {
    throw new Error("paypal userinfo: missing payer_id");
  }
  return { payerId };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadBankcontact(
  id: number,
): Promise<typeof financeBankcontact.$inferSelect> {
  const [row] = await db
    .select()
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, id))
    .limit(1);
  if (!row) throw APIError.notFound(`bankcontact ${id} not found`);
  return row;
}

function assertPaypalEnvironment(
  row: typeof financeBankcontact.$inferSelect,
): PaypalEnvironment {
  if (row.access_type !== "paypal") {
    throw APIError.failedPrecondition(
      `bankcontact ${row.id} is access_type="${row.access_type}", not "paypal"`,
    );
  }
  if (row.paypal_environment !== "sandbox" && row.paypal_environment !== "live") {
    throw APIError.failedPrecondition(
      `bankcontact ${row.id} is missing a valid paypal_environment ("sandbox"|"live")`,
    );
  }
  return row.paypal_environment;
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
    throw APIError.failedPrecondition(
      `PayPal app credentials for "${env}" are not configured`,
    );
  }
  return { clientId, clientSecret };
}

/**
 * Look up or create the finance_account for this PayPal wallet.
 * Returns the account id.
 */
export async function ensurePaypalAccount(
  bankcontactId: number,
  payerId: string,
): Promise<number> {
  const existing = await db
    .select({ id: financeAccount.id })
    .from(financeAccount)
    .where(eq(financeAccount.bankcontact_id, bankcontactId))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  // Look up the "giro" account_type — PayPal balances behave most like
  // a current account from a bookkeeping point of view.
  const [giroType] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .where(eq(financeAccountType.kind, "giro"))
    .limit(1);
  if (!giroType) {
    throw new Error(
      "finance_account_type for kind=giro is missing — seed data not loaded?",
    );
  }

  const [bc] = await db
    .select({ name: financeBankcontact.name })
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, bankcontactId))
    .limit(1);
  const label = bc?.name ? `PayPal ${bc.name}` : "PayPal";

  const [row] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bankcontactId,
      fints_account_number: payerId,
      type_id: giroType.id,
      currency_code: "EUR",
      account_number: payerId,
      label,
    })
    .returning({ id: financeAccount.id });
  return row.id;
}

/**
 * Decrypt + return the stored PayPal credentials for a bankcontact —
 * convenience helper that the disconnect endpoint and tests share.
 */
export async function readPaypalCredentials(
  bankcontactId: number,
): Promise<PaypalCredentials | null> {
  const [row] = await db
    .select({ credentials_encrypted: financeBankcontact.credentials_encrypted })
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, bankcontactId))
    .limit(1);
  if (!row?.credentials_encrypted) return null;
  const bundle = decryptCredentialBundle(row.credentials_encrypted);
  return bundle.kind === "paypal" ? bundle : null;
}

async function readBodySafe(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<unreadable body>";
  }
}

function respondWithSuccess(
  res: { writeHead: (status: number, headers: Record<string, string>) => void; end: () => void },
  bankcontactId: number,
): void {
  const target = new URL(
    `/finanzen/bankkontakte/${bankcontactId}`,
    FRONTEND_BASE_URL,
  );
  target.searchParams.set("paypal", "connected");
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

function respondWithError(
  res: { writeHead: (status: number, headers: Record<string, string>) => void; end: () => void },
  reason: string,
  bankcontactId: number | null,
): void {
  const path = bankcontactId
    ? `/finanzen/bankkontakte/${bankcontactId}`
    : `/finanzen/bankkontakte`;
  const target = new URL(path, FRONTEND_BASE_URL);
  target.searchParams.set("paypal", "error");
  target.searchParams.set("reason", reason);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}
