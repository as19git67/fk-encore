/**
 * Utility meters — reading ↔ finance transaction endpoints
 * (Issue #792, Etappe 8 / #1018).
 *
 *   GET    /meters/readings/:readingId/transactions                 (meters.view + finance.view)
 *   POST   /meters/readings/:readingId/transactions                 (meters.read_entry + finance.view)
 *   DELETE /meters/readings/:readingId/transactions/:transactionId  (meters.read_entry + finance.view)
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  linkReadingTransaction,
  listReadingTransactions,
  unlinkReadingTransaction,
  type AuthContext,
  type LinkedTransactionDto,
} from "./reading-transactions.service";

function requireAuth(meterPermission: string): AuthContext {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, meterPermission);
  requirePermission(auth, "finance.view");
  return { userId: parseInt(auth.userID, 10), permissions: auth.permissions };
}

export const listReadingTransactionLinks = api(
  { expose: true, method: "GET", path: "/meters/readings/:readingId/transactions", auth: true },
  async ({ readingId }: { readingId: number }): Promise<{ items: LinkedTransactionDto[] }> => {
    const auth = requireAuth("meters.view");
    return { items: await listReadingTransactions(auth, readingId) };
  },
);

interface LinkRequest {
  readingId: number;
  transactionId: number;
}

export const linkReadingTransactionLink = api(
  { expose: true, method: "POST", path: "/meters/readings/:readingId/transactions", auth: true },
  async ({ readingId, transactionId }: LinkRequest): Promise<{ linked: boolean }> => {
    const auth = requireAuth("meters.read_entry");
    return await linkReadingTransaction(auth, readingId, transactionId);
  },
);

export const unlinkReadingTransactionLink = api(
  {
    expose: true,
    method: "DELETE",
    path: "/meters/readings/:readingId/transactions/:transactionId",
    auth: true,
  },
  async ({ readingId, transactionId }: LinkRequest): Promise<{ ok: boolean }> => {
    const auth = requireAuth("meters.read_entry");
    await unlinkReadingTransaction(auth, readingId, transactionId);
    return { ok: true };
  },
);
