import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "http";
import db from "../db/database";
import {
  financeAccountAccess,
  financeBasketSnapshot,
  financeTransaction,
  financeTransactionSplit,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";

function auth() {
  const value = getAuthData()!;
  requirePermission(value, "finance.view");
  return value;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw APIError.invalidArgument(`request body exceeds ${limit} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody<T>(raw: string): T {
  if (!raw.trim()) throw APIError.invalidArgument("empty request body, expected JSON");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw APIError.invalidArgument(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeRawError(res: ServerResponse, err: unknown): void {
  if (err instanceof APIError) {
    const statusByCode: Record<string, number> = {
      invalid_argument: 400,
      unauthenticated: 401,
      permission_denied: 403,
      not_found: 404,
      already_exists: 409,
      failed_precondition: 400,
      resource_exhausted: 429,
      internal: 500,
      unavailable: 503,
    };
    writeJson(res, statusByCode[err.code] ?? 500, { code: err.code, message: err.message });
    return;
  }
  writeJson(res, 500, { code: "internal", message: err instanceof Error ? err.message : String(err) });
}

async function allowedIds(ids: number[], write = false): Promise<number[]> {
  const current = auth();
  const unique = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];
  if (!unique.length) return [];
  if (current.permissions.includes("finance.admin")) {
    const rows = await db.select({ id: financeTransaction.id }).from(financeTransaction).where(inArray(financeTransaction.id, unique));
    return rows.map(row => row.id);
  }
  const rows = await db.select({ id: financeTransaction.id })
    .from(financeTransaction)
    .innerJoin(financeAccountAccess, and(
      eq(financeAccountAccess.account_id, financeTransaction.account_id),
      eq(financeAccountAccess.user_id, Number(current.userID)),
      ...(write ? [eq(financeAccountAccess.level, "write")] : []),
    ))
    .where(inArray(financeTransaction.id, unique));
  return rows.map(row => row.id);
}

export interface SplitInput {
  amount: number | string;
  tags?: string[];
  notice?: string | null;
  is_tax_relevant?: boolean;
}

type BasketSnapshotRow = typeof financeBasketSnapshot.$inferSelect;
type TransactionSplitRow = typeof financeTransactionSplit.$inferSelect;

function normalizeId(value: number | string | bigint): number {
  return Number(value);
}

function normalizeIdArray(values: Array<number | string | bigint>): number[] {
  return values.map(normalizeId).filter(Number.isInteger);
}

function basketSnapshotDto(snapshot: BasketSnapshotRow) {
  return {
    id: normalizeId(snapshot.id),
    name: snapshot.name,
    tx_ids: normalizeIdArray(snapshot.tx_ids as Array<number | string | bigint>),
    created_at: snapshot.created_at,
    updated_at: snapshot.updated_at,
  };
}

async function listBasketSnapshotDtosForCurrentUser() {
  const current = auth();
  const rows = await db.select().from(financeBasketSnapshot).where(eq(financeBasketSnapshot.user_id, Number(current.userID)));
  return rows.map(basketSnapshotDto);
}

async function saveBasketSnapshotForCurrentUser(name: string, transaction_ids: number[]) {
  const current = auth();
  const trimmed = name?.trim();
  if (!trimmed) throw APIError.invalidArgument("name required");
  const ids = await allowedIds(transaction_ids);
  const [saved] = await db.insert(financeBasketSnapshot).values({ user_id: Number(current.userID), name: trimmed, tx_ids: ids })
    .onConflictDoUpdate({
      target: [financeBasketSnapshot.user_id, financeBasketSnapshot.name],
      set: { tx_ids: ids, updated_at: sql`NOW()` },
    }).returning();
  return basketSnapshotDto(saved);
}

async function loadBasketSnapshotForCurrentUser(id: number) {
  const current = auth();
  const [snapshot] = await db.select().from(financeBasketSnapshot).where(and(eq(financeBasketSnapshot.id, id), eq(financeBasketSnapshot.user_id, Number(current.userID))));
  if (!snapshot) throw APIError.notFound("basket not found");
  const snapshotDto = basketSnapshotDto(snapshot);
  const ids = await allowedIds(snapshotDto.tx_ids);
  return { ...snapshotDto, transaction_ids: ids, missing: snapshotDto.tx_ids.length - ids.length };
}

async function deleteBasketSnapshotForCurrentUser(id: number) {
  const current = auth();
  const deleted = await db.delete(financeBasketSnapshot).where(and(eq(financeBasketSnapshot.id, id), eq(financeBasketSnapshot.user_id, Number(current.userID)))).returning({ id: financeBasketSnapshot.id });
  return { deleted: deleted.length > 0 };
}

function idFromQuery(req: IncomingMessage): number {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) throw APIError.invalidArgument("valid id query parameter required");
  return id;
}

function transactionSplitDto(split: TransactionSplitRow) {
  return {
    id: normalizeId(split.id),
    transaction_id: normalizeId(split.transaction_id),
    amount: split.amount,
    tags: Array.isArray(split.tags) ? split.tags : [],
    notice: split.notice,
    is_tax_relevant: split.is_tax_relevant,
    created_at: split.created_at,
  };
}

export const setTransactionSplits = api(
  { expose: true, method: "PUT", path: "/finance/transactions/:transactionId/splits", auth: true },
  async ({ transactionId, splits }: { transactionId: number; splits: SplitInput[] }) => {
    const allowed = await allowedIds([transactionId], true);
    if (!allowed.length) throw APIError.permissionDenied("write access required");
    if (!Array.isArray(splits) || splits.length < 2) throw APIError.invalidArgument("at least two splits required");
    const [transaction] = await db.select({ amount: financeTransaction.amount }).from(financeTransaction).where(eq(financeTransaction.id, transactionId));
    const normalized = splits.map(split => ({ ...split, amount: Number(split.amount) }));
    if (normalized.some(split => !Number.isFinite(split.amount) || split.amount === 0)) throw APIError.invalidArgument("split amounts must be non-zero numbers");
    const cents = (value: number) => Math.round(value * 100);
    if (normalized.reduce((sum, split) => sum + cents(split.amount), 0) !== cents(Number(transaction.amount))) {
      throw APIError.invalidArgument("split sum must equal transaction amount");
    }
    await db.transaction(async tx => {
      await tx.delete(financeTransactionSplit).where(eq(financeTransactionSplit.transaction_id, transactionId));
      await tx.insert(financeTransactionSplit).values(normalized.map(split => ({
        transaction_id: transactionId,
        amount: split.amount.toFixed(2),
        tags: [...new Set((split.tags ?? []).map(tag => tag.trim()).filter(Boolean))],
        notice: split.notice?.trim() || null,
        is_tax_relevant: !!split.is_tax_relevant,
      })));
    });
    return { saved: normalized.length };
  },
);

export const getTransactionSplits = api(
  { expose: true, method: "GET", path: "/finance/transactions/:transactionId/splits", auth: true },
  async ({ transactionId }: { transactionId: number }) => {
    if (!(await allowedIds([transactionId])).length) throw APIError.notFound("transaction not found");
    const rows = await db.select().from(financeTransactionSplit).where(eq(financeTransactionSplit.transaction_id, transactionId));
    return { items: rows.map(transactionSplitDto) };
  },
);

export const listBasketSnapshots = api(
  { expose: true, method: "GET", path: "/finance/baskets", auth: true },
  async () => {
    return { items: await listBasketSnapshotDtosForCurrentUser() };
  },
);

export const saveBasketSnapshot = api(
  { expose: true, method: "POST", path: "/finance/baskets", auth: true },
  async ({ name, transaction_ids }: { name: string; transaction_ids: number[] }) => {
    return saveBasketSnapshotForCurrentUser(name, transaction_ids);
  },
);

export const loadBasketSnapshot = api(
  { expose: true, method: "GET", path: "/finance/baskets/:id", auth: true },
  async ({ id }: { id: number }) => {
    return loadBasketSnapshotForCurrentUser(id);
  },
);

export const deleteBasketSnapshot = api(
  { expose: true, method: "DELETE", path: "/finance/baskets/:id", auth: true },
  async ({ id }: { id: number }) => {
    return deleteBasketSnapshotForCurrentUser(id);
  },
);

export const listBasketSnapshotsRaw = api.raw(
  { expose: true, method: "GET", path: "/finance/basket-snapshots", auth: true },
  async (_req, res) => {
    try {
      writeJson(res, 200, { items: await listBasketSnapshotDtosForCurrentUser() });
    } catch (err) {
      writeRawError(res, err);
    }
  },
);

export const saveBasketSnapshotRaw = api.raw(
  { expose: true, method: "POST", path: "/finance/basket-snapshots", auth: true },
  async (req, res) => {
    try {
      const body = parseJsonBody<{ name: string; transaction_ids: number[] }>(await readBody(req));
      writeJson(res, 200, await saveBasketSnapshotForCurrentUser(body.name, body.transaction_ids));
    } catch (err) {
      writeRawError(res, err);
    }
  },
);

export const loadBasketSnapshotRaw = api.raw(
  { expose: true, method: "GET", path: "/finance/basket-snapshot", auth: true },
  async (req, res) => {
    try {
      writeJson(res, 200, await loadBasketSnapshotForCurrentUser(idFromQuery(req)));
    } catch (err) {
      writeRawError(res, err);
    }
  },
);

export const deleteBasketSnapshotRaw = api.raw(
  { expose: true, method: "DELETE", path: "/finance/basket-snapshot", auth: true },
  async (req, res) => {
    try {
      writeJson(res, 200, await deleteBasketSnapshotForCurrentUser(idFromQuery(req)));
    } catch (err) {
      writeRawError(res, err);
    }
  },
);
