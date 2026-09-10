// Round-trip cover for the transaction↔document links.
//
// These four endpoints had no tests at all, and reached the database
// through plain JS template literals passed to db.execute — the ids were
// spliced into the query text and only the `number` declarations in the
// request schema kept that from being injectable. They now use the Drizzle
// `sql` tag, so the values are bound; this pins that the plumbing still
// works and that the access checks in front of it still bite.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  documents,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeTransaction,
  users,
} from "../db/schema";
import {
  linkDocuments,
  unlinkDocument,
  transactionDocumentLinks,
  documentTransactionLinks,
} from "./document-matches";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

let owner: { id: number };
let stranger: { id: number };
let accountId: number;
let transactionId: number;
let documentId: number;

async function insertUser(email: string): Promise<{ id: number }> {
  const [row] = await db
    .insert(users)
    .values({ email, name: email, password_hash: "x" })
    .returning({ id: users.id });
  return row!;
}

async function insertDocument(userId: number, name: string): Promise<number> {
  const [row] = await db
    .insert(documents)
    .values({
      user_id: userId,
      sha256: name.padEnd(64, "0"),
      original_filename: `${name}.pdf`,
      mime_type: "application/pdf",
      size_bytes: 1,
      disk_path: `/tmp/${name}.pdf`,
      title: name,
    })
    .returning({ id: documents.id });
  return row!.id;
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_document`);
  await db.delete(financeTransaction);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(documents);
  await db.delete(users);

  owner = await insertUser("owner@test.local");
  stranger = await insertUser("stranger@test.local");

  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [account] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: null,
      type_id: type!.id,
      currency_code: "EUR",
      account_number: "AN-1",
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  accountId = account!.id;

  await db.insert(financeAccountAccess).values({
    account_id: accountId,
    user_id: owner.id,
    level: "write",
  });

  const [tx] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: "2024-03-01",
      amount: "-19.99",
      currency_code: "EUR",
      counterparty: "Beispiel GmbH",
      dedupe_hash: "tx1".padEnd(64, "0"),
    })
    .returning({ id: financeTransaction.id });
  transactionId = tx!.id;

  documentId = await insertDocument(owner.id, "rechnung");

  setAuth(String(owner.id), ["finance.view"]);
});

describe("linking a document to a transaction", () => {
  it("shows up from both sides", async () => {
    const res = await (linkDocuments as any)({
      transaction_ids: [transactionId],
      document_ids: [documentId],
    });
    expect(res.linked).toBe(1);

    const fromTx = await (transactionDocumentLinks as any)({ transactionId });
    expect(fromTx.items.map((i: any) => i.document_id)).toEqual([documentId]);

    const fromDoc = await (documentTransactionLinks as any)({ documentId });
    expect(fromDoc.items.map((i: any) => i.transaction_id)).toEqual([transactionId]);
  });

  it("is idempotent", async () => {
    await (linkDocuments as any)({ transaction_ids: [transactionId], document_ids: [documentId] });
    await (linkDocuments as any)({ transaction_ids: [transactionId], document_ids: [documentId] });

    const fromTx = await (transactionDocumentLinks as any)({ transactionId });
    expect(fromTx.items).toHaveLength(1);
  });

  it("can be undone", async () => {
    await (linkDocuments as any)({ transaction_ids: [transactionId], document_ids: [documentId] });
    await (unlinkDocument as any)({ transaction_id: transactionId, document_id: documentId });

    const fromTx = await (transactionDocumentLinks as any)({ transactionId });
    expect(fromTx.items).toHaveLength(0);
  });

  it("only removes the pair it was given", async () => {
    const other = await insertDocument(owner.id, "quittung");
    await (linkDocuments as any)({
      transaction_ids: [transactionId],
      document_ids: [documentId, other],
    });

    await (unlinkDocument as any)({ transaction_id: transactionId, document_id: documentId });

    const fromTx = await (transactionDocumentLinks as any)({ transactionId });
    expect(fromTx.items.map((i: any) => i.document_id)).toEqual([other]);
  });
});

describe("access checks in front of the links", () => {
  it("refuses a transaction the caller has no access to", async () => {
    setAuth(String(stranger.id), ["finance.view"]);
    await expect(
      (linkDocuments as any)({ transaction_ids: [transactionId], document_ids: [documentId] }),
    ).rejects.toThrow(/Berechtigung/);
  });

  it("refuses to read links on a transaction the caller cannot see", async () => {
    await (linkDocuments as any)({ transaction_ids: [transactionId], document_ids: [documentId] });

    setAuth(String(stranger.id), ["finance.view"]);
    await expect((transactionDocumentLinks as any)({ transactionId })).rejects.toThrow(
      /Berechtigung/,
    );
  });

  it("hides a linked document the caller may not see", async () => {
    // The link row exists, but the document belongs to somebody else and
    // the visibility check runs per row.
    const foreign = await insertDocument(stranger.id, "fremd");
    await db.execute(
      sql`INSERT INTO finance_transaction_document (transaction_id, document_id) VALUES (${transactionId}, ${foreign})`,
    );

    const fromTx = await (transactionDocumentLinks as any)({ transactionId });
    expect(fromTx.items).toHaveLength(0);
  });

  it("requires finance.view", async () => {
    setAuth(String(owner.id), []);
    await expect((transactionDocumentLinks as any)({ transactionId })).rejects.toThrow(
      /finance\.view/,
    );
  });
});

describe("the values reach the database as parameters", () => {
  it("does not confuse an id with the SQL around it", async () => {
    // A transaction id is a bigserial, so a caller-supplied value that is
    // not a number can only ever be rejected — never concatenated into the
    // statement, which is what the template literals allowed.
    const hostile = "1 OR 1=1" as unknown as number;
    await expect(
      (unlinkDocument as any)({ transaction_id: hostile, document_id: documentId }),
    ).rejects.toThrow();

    const [{ count }] = (
      await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM finance_transaction`,
      )
    ).rows;
    expect(Number(count)).toBe(1);
  });
});
