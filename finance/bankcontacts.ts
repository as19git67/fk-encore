/**
 * CRUD endpoints for finance_bankcontact plus a dedicated endpoint for
 * storing AES-GCM-encrypted credentials (the PIN / password that
 * lib-fints uses when dialling the bank). Credentials NEVER travel
 * through the regular CRUD responses — they're write-only via the
 * `…/credentials` endpoint and only ever decrypted inside
 * `fints-client.ts`.
 *
 * Permission: every endpoint requires `finance.accounts.manage`.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { eq, inArray } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import { checkRateLimit } from "../user/rateLimiter";
import db from "../db/database";
import {
  financeAccount,
  financeBankcontact,
  type FinanceSyncSlot,
} from "../db/schema";
import { encryptCredentials } from "./encryption";
import {
  clearBankingInformationCache,
  evictCachedClient,
  probeTanMethods,
} from "./fints-client";

console.log("[boot] finance/bankcontacts.ts: all imports resolved");

// ---------- Response shapes ----------
//
// credentials_encrypted and sync_times are stripped from the DTO —
// credentials must stay write-only, sync_times have their own endpoint
// in Etappe 6.

interface TanMethodCacheEntry {
  id: number;
  name: string;
  isDecoupled: boolean;
}

interface BankcontactView {
  id: number;
  name: string;
  blz: string;
  login: string;
  server_url: string;
  tan_method: string | null;
  credentials_set: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
  created_at: string | null;
  /**
   * Bank-advertised TAN methods from the last successful probe.
   * Empty array when the user has never probed this bankcontact.
   */
  available_tan_methods: TanMethodCacheEntry[];
  /**
   * UI-configured cron-like slots driving the sync cron. Surfaced on
   * the list response so the frontend overview widget can compute the
   * next sync moment without an extra round-trip per bankcontact.
   */
  sync_times: FinanceSyncSlot[];
}

function toView(row: typeof financeBankcontact.$inferSelect): BankcontactView {
  return {
    id: row.id,
    name: row.name,
    blz: row.blz,
    login: row.login,
    server_url: row.server_url,
    tan_method: row.tan_method,
    credentials_set: !!row.credentials_encrypted,
    last_sync_at: row.last_sync_at,
    last_sync_status: row.last_sync_status,
    created_at: row.created_at,
    available_tan_methods: row.available_tan_methods ?? [],
    sync_times: (row.sync_times as FinanceSyncSlot[] | null) ?? [],
  };
}

// ---------- List ----------

interface ListResponse {
  items: BankcontactView[];
}

export const listBankcontacts = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/bankcontacts",
    auth: true,
  },
  async (): Promise<ListResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    const rows = await db.select().from(financeBankcontact);
    return { items: rows.map(toView) };
  },
);

// ---------- Get by id ----------

interface GetParams {
  id: number;
}

export const getBankcontact = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/bankcontacts/:id",
    auth: true,
  },
  async ({ id }: GetParams): Promise<BankcontactView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    const row = await loadBankcontact(id);
    return toView(row);
  },
);

// ---------- Create ----------

interface CreateParams {
  name: string;
  blz: string;
  login: string;
  server_url: string;
  tan_method?: string;
}

export const createBankcontact = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/bankcontacts",
    auth: true,
  },
  async (p: CreateParams): Promise<BankcontactView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    assertRequiredStrings({
      name: p.name,
      blz: p.blz,
      login: p.login,
      server_url: p.server_url,
    });
    const [row] = await db
      .insert(financeBankcontact)
      .values({
        name: p.name.trim(),
        blz: p.blz.trim(),
        login: p.login.trim(),
        server_url: p.server_url.trim(),
        tan_method: p.tan_method?.trim() || null,
      })
      .returning();
    return toView(row);
  },
);

// ---------- Update (Stammdaten only) ----------

interface UpdateParams {
  id: number;
  name?: string;
  blz?: string;
  login?: string;
  server_url?: string;
  tan_method?: string | null;
}

export const updateBankcontact = api(
  {
    expose: true,
    method: "PUT",
    path: "/finance/bankcontacts/:id",
    auth: true,
  },
  async (p: UpdateParams): Promise<BankcontactView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    await loadBankcontact(p.id);

    const patch: Partial<typeof financeBankcontact.$inferInsert> = {};
    if (p.name !== undefined) patch.name = p.name.trim();
    if (p.blz !== undefined) patch.blz = p.blz.trim();
    if (p.login !== undefined) patch.login = p.login.trim();
    if (p.server_url !== undefined) patch.server_url = p.server_url.trim();
    if (p.tan_method !== undefined) {
      patch.tan_method = p.tan_method === null ? null : p.tan_method.trim() || null;
    }
    if (Object.keys(patch).length === 0) {
      throw APIError.invalidArgument("no fields to update");
    }
    const [row] = await db
      .update(financeBankcontact)
      .set(patch)
      .where(eq(financeBankcontact.id, p.id))
      .returning();
    return toView(row);
  },
);

// ---------- Delete ----------
//
// Accounts linked to this bankcontact are *unlinked* (bankcontact_id
// and fints_account_number set to NULL via the FK's ON DELETE SET
// NULL) — they turn into manual accounts and keep every transaction.
// This matches the "beim Löschen eines Bankzugangs fallen verknüpfte
// Konten auf manuell zurück" contract.

interface DeleteParams {
  id: number;
}

interface DeleteResponse {
  deleted: true;
  accounts_unlinked: number;
}

export const deleteBankcontact = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/bankcontacts/:id",
    auth: true,
  },
  async (p: DeleteParams): Promise<DeleteResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    await loadBankcontact(p.id);

    // Count linked accounts for the response summary. The actual
    // unlink happens via FK ON DELETE SET NULL once we delete the
    // bankcontact below, so there's no race between "gather count"
    // and "unlink".
    const linked = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.bankcontact_id, p.id));

    // Explicitly clear fints_account_number too — ON DELETE SET NULL
    // only touches the FK column, so without this we'd leave an
    // orphaned fints number that the next link call for a different
    // bankcontact could collide with.
    if (linked.length > 0) {
      await db
        .update(financeAccount)
        .set({ fints_account_number: null })
        .where(
          inArray(
            financeAccount.id,
            linked.map((a) => a.id),
          ),
        );
    }

    // finance_tan_session cascades, finance_account.bankcontact_id
    // is set to NULL by the FK.
    await db.delete(financeBankcontact).where(eq(financeBankcontact.id, p.id));
    // The cached client (if any) is now pointing at a row that no
    // longer exists — evict it so the next bankcontact created with
    // the same id doesn't accidentally inherit the dialog.
    evictCachedClient(p.id);

    return {
      deleted: true,
      accounts_unlinked: linked.length,
    };
  },
);

// ---------- Set credentials ----------
//
// Accepts the PIN / password in plaintext, encrypts it, and writes to
// credentials_encrypted. The endpoint body IS the most sensitive data
// in the whole module — TLS is the only thing between it and the
// network, so callers (UI + API client) must use HTTPS in production.

interface SetCredentialsParams {
  id: number;
  pin: string;
}

interface SetCredentialsResponse {
  credentials_set: true;
}

export const setBankcontactCredentials = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/bankcontacts/:id/credentials",
    auth: true,
  },
  async (p: SetCredentialsParams): Promise<SetCredentialsResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    // Rate-limit per user×bankcontact. See docs/finance-rate-limiting.md §2.
    checkRateLimit(`bank-creds:${auth.userID}:${p.id}`, {
      maxAttempts: 10,
      windowMs: 15 * 60_000,
      message: "Too many credential updates for this bank contact.",
    });

    if (typeof p.pin !== "string" || p.pin.length === 0) {
      throw APIError.invalidArgument("pin must be a non-empty string");
    }
    await loadBankcontact(p.id);

    const blob = encryptCredentials(p.pin);
    await db
      .update(financeBankcontact)
      .set({ credentials_encrypted: blob })
      .where(eq(financeBankcontact.id, p.id));
    // Drop the warm-start cache: lib-fints' systemId is bound to the
    // PIN/customer combo, so a stale cache after a PIN change would
    // just produce wrong-PIN errors on the next warm sync. Also
    // evict any in-process client — its dialog state is tied to the
    // old PIN.
    await clearBankingInformationCache(p.id);
    evictCachedClient(p.id);
    return { credentials_set: true };
  },
);

// ---------- Probe TAN methods ----------
//
// Runs the first half of the FinTS init dialog to retrieve the list
// of TAN methods the bank offers for this user, so the admin can
// pick one in the UI without knowing the numeric ID upfront. Needs
// credentials already stored on the bankcontact.

interface ProbeTanMethodsParams {
  id: number;
}

interface ProbeTanMethodsApiResult {
  state: "ok" | "tan-required" | "error";
  methods?: Array<{ id: number; name: string; isDecoupled: boolean }>;
  errorCode?: string;
  errorMessage?: string;
}

export const probeBankcontactTanMethods = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/bankcontacts/:id/tan-methods",
    auth: true,
  },
  async (p: ProbeTanMethodsParams): Promise<ProbeTanMethodsApiResult> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    // Rate-limit per user×bankcontact so this doesn't become a
    // cheap way to burn credentials against the bank's log. Same
    // scope as bank-creds; 10/15m keeps retries generous.
    checkRateLimit(`tan-probe:${auth.userID}:${p.id}`, {
      maxAttempts: 10,
      windowMs: 15 * 60_000,
      message: "Too many TAN-method probes for this bank contact.",
    });

    const row = await loadBankcontact(p.id);
    if (!row.credentials_encrypted) {
      throw APIError.failedPrecondition(
        "set credentials via POST /finance/bankcontacts/:id/credentials first",
      );
    }

    const result = await probeTanMethods(p.id);
    // Persist the fresh list on the bankcontact so the UI has a
    // populated picker after a page reload without re-probing. Only
    // stash on success — a TAN-required / error probe leaves the
    // existing cache (if any) untouched.
    if (result.state === "ok" && result.methods) {
      await db
        .update(financeBankcontact)
        .set({ available_tan_methods: result.methods })
        .where(eq(financeBankcontact.id, p.id));
    }
    return {
      state: result.state,
      methods: result.methods,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  },
);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

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

function assertRequiredStrings(fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw APIError.invalidArgument(`${key} must be a non-empty string`);
    }
  }
}
