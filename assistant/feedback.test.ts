/**
 * Feedback under an answer (assistent-wegfindung.md, stage 6): the turn
 * behind an answer becomes a trace without row content, an entry belongs to
 * the conversation's owner, the list and the case draft are for admins.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import db from "../db/database";
import { assistantConversation, assistantFeedback, assistantMessage } from "../db/schema";
import { caseDraft, deleteFeedback, giveFeedback, listFeedback, rowsOfDigest, turnOf } from "./feedback";

function setAuth(userID: string, permissions: string[] = ["module.assistant"]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(sql`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1))`);
}

type Row = typeof assistantMessage.$inferInsert;

/** A stored turn: question, a search that found rows, a failed call, the answer. */
function storedTurn(conversation_id: number): Row[] {
  return [
    { conversation_id, role: "user", content: "Zeig mir die Rechnungen vom Beispielhandwerker." },
    {
      conversation_id,
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", name: "search_documents", arguments: JSON.stringify({ q: "Rechnung", correspondent: "Beispielhandwerker" }) },
        { id: "c2", name: "get_document_summary", arguments: JSON.stringify({ ids: [1] }) },
      ],
    },
    { conversation_id, role: "tool", tool_call_id: "c1", content: "id | title\n1 | Rechnung\n(1 row)", digest: "[earlier result of search_documents: 1 row, ids 1]" },
    { conversation_id, role: "tool", tool_call_id: "c2", content: "error: get_document_summary failed: no access", digest: "[earlier result of get_document_summary: 0 rows]" },
    { conversation_id, role: "assistant", content: "Ich habe eine Rechnung gefunden." },
  ];
}

async function conversationWithTurn(userId: number): Promise<{ conversationId: number; answerId: number; questionId: number }> {
  const [c] = await db.insert(assistantConversation).values({ user_id: userId }).returning({ id: assistantConversation.id });
  const ids: number[] = [];
  for (const row of storedTurn(c.id)) {
    const [m] = await db.insert(assistantMessage).values(row).returning({ id: assistantMessage.id });
    ids.push(m.id);
  }
  return { conversationId: c.id, answerId: ids[ids.length - 1], questionId: ids[0] };
}

beforeEach(async () => {
  await db.delete(assistantFeedback);
  await db.delete(assistantMessage);
  await db.delete(assistantConversation);
  await ensureUser(711);
  await ensureUser(712);
  setAuth("711");
});

describe("the trace of a turn", () => {
  it("reads row counts off digests", () => {
    expect(rowsOfDigest("[earlier result of list_photos: 12 rows, ids 1,2]")).toBe(12);
    expect(rowsOfDigest("[earlier result of consumption_report: 1 row]")).toBe(1);
    expect(rowsOfDigest("[benchmark result]")).toBeNull();
    expect(rowsOfDigest(null)).toBeNull();
  });

  it("holds tools, arguments, row counts and errors, never the rows", async () => {
    const { answerId } = await conversationWithTurn(711);
    const rows = await db.select().from(assistantMessage);
    const turn = turnOf(rows, answerId)!;
    expect(turn.question).toBe("Zeig mir die Rechnungen vom Beispielhandwerker.");
    expect(turn.trace).toEqual([
      { tool: "search_documents", arguments: { q: "Rechnung", correspondent: "Beispielhandwerker" }, rows: 1, error: null },
      { tool: "get_document_summary", arguments: { ids: [1] }, rows: null, error: "error: get_document_summary failed: no access" },
    ]);
    expect(JSON.stringify(turn)).not.toContain("id | title");
  });

  it("is null for a question or a tool row", async () => {
    const { questionId } = await conversationWithTurn(711);
    const rows = await db.select().from(assistantMessage);
    expect(turnOf(rows, questionId)).toBeNull();
  });

  it("drafts a case with the calls that ran as expectations", () => {
    const draft = JSON.parse(caseDraft({
      id: 7,
      question: "Frage",
      trace: [
        { tool: "list_meters", arguments: {}, rows: 2, error: null },
        { tool: "consumption_report", arguments: { meter_id: 3 }, rows: null, error: "error: consumption_report failed" },
      ],
    }));
    expect(draft.id).toBe("feedback-7");
    expect(draft.expect).toEqual([{ tool: "list_meters", args: {} }]);
    expect(Object.keys(draft.results)).toEqual(["list_meters", "consumption_report"]);
  });
});

describe("giving feedback", () => {
  it("stores the turn under the answer for its owner, and a second thumbs replaces the first", async () => {
    const { answerId, conversationId } = await conversationWithTurn(711);
    const first = await giveFeedback({ id: answerId, verdict: "down", comment: "falsches Werkzeug" });
    expect(first.verdict).toBe("down");
    const again = await giveFeedback({ id: answerId, verdict: "up" });
    expect(again.id).toBe(first.id);

    setAuth("711", ["module.assistant", "data.manage"]);
    const { entries } = await listFeedback();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      verdict: "up",
      comment: null,
      conversation_id: conversationId,
      message_id: answerId,
      question: "Zeig mir die Rechnungen vom Beispielhandwerker.",
      answer: "Ich habe eine Rechnung gefunden.",
    });
    expect(entries[0].trace.map((t) => t.tool)).toEqual(["search_documents", "get_document_summary"]);
    expect(JSON.parse(entries[0].case_draft).question).toBe(entries[0].question);
  });

  it("refuses another user's answer, a question, and a bad verdict", async () => {
    const { answerId, questionId } = await conversationWithTurn(711);
    setAuth("712");
    await expect(giveFeedback({ id: answerId, verdict: "down" })).rejects.toThrow("message not found");
    setAuth("711");
    await expect(giveFeedback({ id: questionId, verdict: "down" })).rejects.toThrow("under an answer");
    await expect(giveFeedback({ id: answerId, verdict: "meh" as "up" })).rejects.toThrow("verdict");
  });

  it("outlives its conversation", async () => {
    const { answerId, conversationId } = await conversationWithTurn(711);
    await giveFeedback({ id: answerId, verdict: "down" });
    await db.delete(assistantConversation);
    setAuth("711", ["module.assistant", "data.manage"]);
    const { entries } = await listFeedback();
    expect(entries).toHaveLength(1);
    expect(entries[0].conversation_id).toBeNull();
    expect(entries[0].message_id).toBeNull();
    expect(entries[0].question).toContain("Beispielhandwerker");
    expect(conversationId).toBeGreaterThan(0);
  });

  it("lists and deletes only with data.manage", async () => {
    const { answerId } = await conversationWithTurn(711);
    const { id } = await giveFeedback({ id: answerId, verdict: "down" });
    await expect(listFeedback()).rejects.toThrow();
    await expect(deleteFeedback({ id })).rejects.toThrow();
    setAuth("712", ["data.manage"]);
    expect((await deleteFeedback({ id })).deleted).toBe(true);
    await expect(deleteFeedback({ id })).rejects.toThrow("feedback not found");
    expect((await listFeedback()).entries).toEqual([]);
  });
});
