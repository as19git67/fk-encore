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
import { eq } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeBankcontact, financeAccount } from "../db/schema";
import { encryptCredentials } from "./encryption";

console.log("[boot] finance/bankcontacts.ts: all imports resolved");

// ---------- Response shapes ----------
//
// credentials_encrypted and sync_times are stripped from the DTO —
// credentials must stay write-only, sync_times have their own endpoint
// in Etappe 6.

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

interface DeleteParams {
  id: number;
}

interface DeleteResponse {
  deleted: true;
}

export const deleteBankcontact = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/bankcontacts/:id",
    auth: true,
  },
  async ({ id }: DeleteParams): Promise<DeleteResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    await loadBankcontact(id);

    const accounts = await db
      .select({ id: financeAccount.id })
      .from(financeAccount)
      .where(eq(financeAccount.bankcontact_id, id))
      .limit(1);
    if (accounts.length > 0) {
      // FK uses ON DELETE RESTRICT; fail early with a readable message.
      throw APIError.failedPrecondition(
        "bankcontact has accounts — delete them first",
      );
    }

    await db.delete(financeBankcontact).where(eq(financeBankcontact.id, id));
    return { deleted: true };
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
    if (typeof p.pin !== "string" || p.pin.length === 0) {
      throw APIError.invalidArgument("pin must be a non-empty string");
    }
    await loadBankcontact(p.id);

    const blob = encryptCredentials(p.pin);
    await db
      .update(financeBankcontact)
      .set({ credentials_encrypted: blob })
      .where(eq(financeBankcontact.id, p.id));
    return { credentials_set: true };
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
