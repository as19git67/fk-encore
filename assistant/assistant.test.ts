import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("./titles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./titles")>()),
  suggestTitle: vi.fn(async () => null),
}));
vi.mock("./llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./llm-client")>();
  return { ...real, chat: vi.fn() };
});

import db from "../db/database";
import { assistantConversation, assistantMessage, assistantProposal } from "../db/schema";
import { __resetRateLimiterForTests } from "../user/rateLimiter";
import { clients, resetClients } from "./clients.test-helper";
import { chat, LlmServiceUnavailableError, type ChatReply } from "./llm-client";
import { __resetLiveTurnsForTests } from "./live";
import { isRouterRequest } from "./router";
import { isSummaryRequest, SUMMARIZE_TURN_NAME } from "./summary";
import {
  __settleSummariesForTests,
  ask,
  cancelAssistantTurn,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  watchTurn,
  WHOLE_TURNS,
  type StreamEvent,
} from "./assistant";

const PERMS = ["module.assistant", "module.meters", "meters.view"];

function setAuth(userID: string, permissions: string[] = PERMS) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1))`,
  );
}

function toolCall(name: string, args: Record<string, unknown>): ChatReply {
  return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function text(content: string): ChatReply {
  return { content, tool_calls: [], finish_reason: "stop" };
}

/**
 * Plays `replies` to the loop's rounds in order, and answers every summary
 * call (which runs after the answer, so its place in the order is not fixed)
 * with `summary` — a summary tool call, or null for an unusable reply.
 */
function scriptWithSummaries(replies: ChatReply[], summary: string | null = "Zusammenfassung der Runde: es ging um die Zähler, gefunden wurde keiner.") {
  const queue = [...replies];
  vi.mocked(chat).mockImplementation(async (req) => {
    // The router's model stage (a question without keywords) chooses nothing: every area stays in play.
    if (isRouterRequest(req)) return text("");
    if (isSummaryRequest(req)) {
      return summary === null
        ? text("kein Werkzeugaufruf")
        : toolCall(SUMMARIZE_TURN_NAME, { summary });
    }
    const next = queue.shift();
    if (!next) throw new Error("script ran out");
    return next;
  });
}

beforeEach(async () => {
  await db.delete(assistantProposal);
  await db.delete(assistantMessage);
  await db.delete(assistantConversation);
  await ensureUser(701);
  await ensureUser(702);
  resetClients();
  vi.mocked(chat).mockReset();
  __resetRateLimiterForTests();
  __resetLiveTurnsForTests();
  setAuth("701");
});

describe("conversations", () => {
  it("belong to their user", async () => {
    const mine = await createConversation({ title: "Zähler" });
    setAuth("702");
    const theirs = await createConversation({});
    expect((await listConversations()).conversations.map((c) => c.id)).toEqual([theirs.id]);
    await expect(getConversation({ id: mine.id })).rejects.toThrow("conversation not found");
    await expect(deleteConversation({ id: mine.id })).rejects.toThrow("conversation not found");
    await expect(ask({ id: mine.id, message: "Hallo" })).rejects.toThrow("conversation not found");

    setAuth("701");
    expect((await deleteConversation({ id: mine.id })).deleted).toBe(true);
    expect((await listConversations()).conversations).toEqual([]);
  });
});

describe("asking", () => {
  it("runs the turn, keeps the transcript and shows only question and answer", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [{ id: 3, name: "Strom Haus", type: "electricity", unit: "kWh", lastReadingValue: 1234, lastReadingAt: "2026-10-01T00:00:00Z" }] });
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("list_meters", {}))
      .mockResolvedValueOnce(text("Der Stromzähler stand zuletzt bei 1234 kWh."));
    const conv = await createConversation({});

    const res = await ask({ id: conv.id, message: "Wie ist der Stand vom Stromzähler?" });

    expect(res.answer).toBe("Der Stromzähler stand zuletzt bei 1234 kWh.");
    expect(res.rounds).toBe(2);
    expect(res.blocks[0]).toMatchObject({ kind: "meters", route: "/zaehler" });
    expect(clients.meter.listMeters).toHaveBeenCalledWith({});

    const rows = await db.select().from(assistantMessage);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(rows[1].tool_calls).toEqual([{ id: "c-list_meters", name: "list_meters", arguments: "{}" }]);
    expect(rows[2].tool_call_id).toBe("c-list_meters");

    const detail = await getConversation({ id: conv.id });
    expect(detail.title).toBe("Wie ist der Stand vom Stromzähler?");
    expect(detail.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Wie ist der Stand vom Stromzähler?"],
      ["assistant", "Der Stromzähler stand zuletzt bei 1234 kWh."],
    ]);
    expect(detail.messages[1].blocks[0]).toMatchObject({ kind: "meters" });
  });

  it("replays earlier turns with their tool calls and each result whole", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    scriptWithSummaries([toolCall("list_meters", {}), text("Keine Zähler."), text("Immer noch keine.")]);
    const conv = await createConversation({});
    await ask({ id: conv.id, message: "Welche Zähler gibt es?" });
    await __settleSummariesForTests();
    await ask({ id: conv.id, message: "Und jetzt?" });

    // The summary of the first turn was written after its answer, onto the answer row.
    const [answerRow] = await db.select().from(assistantMessage).where(eq(assistantMessage.content, "Keine Zähler."));
    expect(answerRow.summary).toMatch(/^Zusammenfassung der Runde/);
    // The summary call saw the turn as it happened, bound to its tool.
    const summaryCall = vi.mocked(chat).mock.calls.map((c) => c[0]).find(isSummaryRequest)!;
    expect(summaryCall.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(summaryCall.tool_choice).toEqual({ type: "function", function: { name: SUMMARIZE_TURN_NAME } });

    // One turn back is still "whole": the second question sees the tool round, not the summary.
    const third = vi.mocked(chat).mock.calls.map((c) => c[0]).filter((r) => !isSummaryRequest(r))[2];
    const replayed = third.messages.slice(1);
    expect(replayed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    const call = replayed[1] as { tool_calls: Array<{ id: string; function: { name: string } }> };
    expect(call.tool_calls[0]!.function.name).toBe("list_meters");
    // The result as the model saw it then, not the one-line digest.
    const [stored] = await db.select().from(assistantMessage).where(eq(assistantMessage.role, "tool"));
    expect(stored.digest).toBe("[earlier result of list_meters: 0 rows]");
    expect(replayed[2]).toEqual({ role: "tool", tool_call_id: call.tool_calls[0]!.id, content: stored.content });
    // The answer stays as written: no note the model could copy.
    expect(replayed[3]).toEqual({ role: "assistant", content: "Keine Zähler." });

    // The second answer records how full the window got and what it still saw.
    const detail = await getConversation({ id: conv.id });
    expect(detail.messages[1].context_usage).toMatchObject({ historyTurns: 0, earlierTurns: 0 });
    expect(detail.messages[3].context_usage).toMatchObject({ historyTurns: 1, keptTurns: 1, earlierTurns: 1, used: null, summarizedTurns: 0 });
    expect(detail.messages[0].context_usage).toBeNull();
  });

  it("replays an older turn as question and summary once newer turns cover it (stage 4)", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [{ id: 3, name: "Strom Haus" }] });
    const conv = await createConversation({});
    // WHOLE_TURNS + 1 turns with a tool call each, every summary written before the next question.
    const script: ChatReply[] = [];
    for (let i = 0; i <= WHOLE_TURNS; i++) script.push(toolCall("list_meters", {}), text(`Antwort ${i}: ein Zähler.`));
    script.push(text("Danke fürs Nachsehen."));
    scriptWithSummaries(script, "Gefragt war nach den Zählern des Haushalts; gefunden wurde einer, Strom Haus.");
    for (let i = 0; i <= WHOLE_TURNS; i++) {
      await ask({ id: conv.id, message: `Frage ${i}: welche Zähler?` });
      await __settleSummariesForTests();
    }
    await ask({ id: conv.id, message: "Danke." });

    const last = vi.mocked(chat).mock.calls.map((c) => c[0]).filter((r) => !isSummaryRequest(r)).at(-1)!;
    const replayed = last.messages.slice(1, -1);
    // The oldest turn: question and summary, with the note of the tools behind it; no tool round.
    expect(replayed[0]).toEqual({ role: "user", content: "Frage 0: welche Zähler?" });
    expect(replayed[1]).toMatchObject({ role: "assistant" });
    const summaryText = (replayed[1] as { content: string }).content;
    expect(summaryText).toContain("Gefragt war nach den Zählern");
    expect(summaryText).toContain("[summary of an earlier turn; tools then: list_meters (1 row). Follow-ups on those rows use from_previous_result.]");
    expect(replayed[2]).toEqual({ role: "user", content: "Frage 1: welche Zähler?" });
    // The newer turns went whole: question, tool call, result, answer.
    expect(replayed.slice(2).map((m) => m.role)).toEqual(Array(WHOLE_TURNS).fill(["user", "assistant", "tool", "assistant"]).flat());
    const detail = await getConversation({ id: conv.id });
    expect(detail.messages.at(-1)!.context_usage).toMatchObject({ historyTurns: WHOLE_TURNS + 1, keptTurns: WHOLE_TURNS + 1, summarizedTurns: 1 });
  });

  it("a turn without a tool call gets no summary and replays as it is; an unusable summary reply changes nothing", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    scriptWithSummaries([text("Hallo!"), toolCall("list_meters", {}), text("Keine Zähler.")], null);
    const conv = await createConversation({});
    await ask({ id: conv.id, message: "Hallo" });
    await __settleSummariesForTests();
    await ask({ id: conv.id, message: "Welche Zähler gibt es?" });
    await __settleSummariesForTests();
    const summaryCalls = vi.mocked(chat).mock.calls.map((c) => c[0]).filter(isSummaryRequest);
    expect(summaryCalls).toHaveLength(1);
    const answers = await db.select().from(assistantMessage).where(eq(assistantMessage.role, "assistant"));
    expect(answers.every((m) => m.summary === null)).toBe(true);
  });

  it("a busy model is 'unavailable', and nothing is stored", async () => {
    vi.mocked(chat).mockRejectedValue(new LlmServiceUnavailableError("inference busy"));
    const conv = await createConversation({});
    await expect(ask({ id: conv.id, message: "Hallo" })).rejects.toMatchObject({ code: "unavailable" });
    expect(await db.select().from(assistantMessage)).toEqual([]);
  });

  it("limits questions per user", async () => {
    vi.mocked(chat).mockResolvedValue(text("ok"));
    const conv = await createConversation({});
    for (let i = 0; i < 20; i++) await ask({ id: conv.id, message: `Frage ${i}` });
    await expect(ask({ id: conv.id, message: "eine zu viel" })).rejects.toMatchObject({ code: "resource_exhausted" });
  });

  it("rejects an empty question and a malformed turn id", async () => {
    const conv = await createConversation({});
    await expect(ask({ id: conv.id, message: "   " })).rejects.toThrow("message is empty");
    await expect(ask({ id: conv.id, message: "x", turnId: "../../etc" })).rejects.toThrow("turnId");
  });
});

describe("watching a turn", () => {
  function fakeStream() {
    const sent: StreamEvent[] = [];
    return { sent, stream: { send: (e: StreamEvent) => { sent.push(e); }, close: vi.fn(async () => {}) } };
  }
  const watch = watchTurn as unknown as (h: { turnId: string }, s: ReturnType<typeof fakeStream>["stream"]) => Promise<void>;

  it("the stream opened first sees every event of the posted turn", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("list_meters", {}))
      .mockImplementationOnce(async (_req, onToken) => {
        onToken?.("Keine ");
        onToken?.("Zähler.");
        return text("Keine Zähler.");
      });
    const conv = await createConversation({});
    const { sent, stream } = fakeStream();

    const watching = watch({ turnId: "turn-0001" }, stream);
    await ask({ id: conv.id, message: "Zähler?", turnId: "turn-0001" });
    await watching;

    expect(sent.map((e) => e.type)).toEqual(["tool_start", "tool_result", "token", "token", "done"]);
    expect(sent.at(-1)).toMatchObject({ type: "done", answer: "Keine Zähler." });
    expect(stream.close).toHaveBeenCalled();
  });

  it("a late stream gets the replay, and another user's stream gets nothing", async () => {
    vi.mocked(chat).mockResolvedValue(text("Hallo."));
    const conv = await createConversation({});
    await ask({ id: conv.id, message: "Hallo", turnId: "turn-0002" });

    const late = fakeStream();
    await watch({ turnId: "turn-0002" }, late.stream);
    expect(late.sent.map((e) => e.type)).toEqual(["done"]);

    setAuth("702");
    const other = fakeStream();
    await watch({ turnId: "turn-0002" }, other.stream);
    expect(other.sent).toEqual([{ type: "error", message: "turn belongs to someone else" }]);
  });

  it("Abbrechen stops the model call, tells the stream and keeps nothing", async () => {
    let started!: () => void;
    const calling = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(chat).mockImplementation(async (_req, onToken, signal) => {
      onToken?.("Ich schau");
      started();
      // Like the real client: the closed request rejects with the signal's reason.
      return new Promise<ChatReply>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    });
    const conv = await createConversation({});
    const { sent, stream } = fakeStream();

    const watching = watch({ turnId: "turn-0004" }, stream);
    const asking = ask({ id: conv.id, message: "Zähler?", turnId: "turn-0004" });
    await calling;

    setAuth("702");
    expect(await cancelAssistantTurn({ turnId: "turn-0004" })).toEqual({ cancelled: false });
    setAuth("701");
    expect(await cancelAssistantTurn({ turnId: "turn-0004" })).toEqual({ cancelled: true });

    await expect(asking).rejects.toMatchObject({ code: "canceled" });
    await watching;
    expect(sent.map((e) => e.type)).toEqual(["token", "cancelled"]);
    expect(await db.select().from(assistantMessage)).toEqual([]);
    // Finished: a second click has nothing left to stop.
    expect(await cancelAssistantTurn({ turnId: "turn-0004" })).toEqual({ cancelled: false });
  });

  it("a cancel that beats the question still stops it", async () => {
    vi.mocked(chat).mockResolvedValue(text("Hallo."));
    const conv = await createConversation({});
    const { sent, stream } = fakeStream();

    const watching = watch({ turnId: "turn-0005" }, stream);
    expect(await cancelAssistantTurn({ turnId: "turn-0005" })).toEqual({ cancelled: true });
    await expect(ask({ id: conv.id, message: "Hallo", turnId: "turn-0005" })).rejects.toMatchObject({ code: "canceled" });
    await watching;

    expect(chat).not.toHaveBeenCalled();
    expect(sent.map((e) => e.type)).toEqual(["cancelled"]);
  });

  it("a turn id cannot be posted twice", async () => {
    vi.mocked(chat).mockResolvedValue(text("Hallo."));
    const conv = await createConversation({});
    await ask({ id: conv.id, message: "Hallo", turnId: "turn-0003" });
    await expect(ask({ id: conv.id, message: "Nochmal", turnId: "turn-0003" })).rejects.toMatchObject({ code: "already_exists" });
  });
});

describe("a conversation too long for the model", () => {
  it("asks for a new conversation instead of failing", async () => {
    const { ContextTooLargeError } = await import("./llm-client");
    vi.mocked(chat).mockRejectedValue(new ContextTooLargeError("too long"));
    const conv = await createConversation({});
    await expect(ask({ id: conv.id, message: "Hallo" })).rejects.toMatchObject({ code: "failed_precondition" });
  });
});

describe("the module permission", () => {
  it("guards every endpoint but the stream", async () => {
    vi.mocked(chat).mockResolvedValue(text("Hallo."));
    const conv = await createConversation({});
    await ask({ id: conv.id, message: "Hallo", turnId: "turn-perm-1" });

    setAuth("701", ["module.meters", "meters.view"]);
    await expect(listConversations()).rejects.toMatchObject({ code: "permission_denied" });
    await expect(createConversation({})).rejects.toMatchObject({ code: "permission_denied" });
    await expect(getConversation({ id: conv.id })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(ask({ id: conv.id, message: "x" })).rejects.toMatchObject({ code: "permission_denied" });

    // The socket carries a media-scope token; it may follow its own turn.
    const sent: StreamEvent[] = [];
    const watch = watchTurn as unknown as (h: { turnId: string }, s: unknown) => Promise<void>;
    await watch({ turnId: "turn-perm-1" }, { send: (e: StreamEvent) => sent.push(e), close: async () => {} });
    expect(sent.map((e) => e.type)).toEqual(["done"]);
  });
});
