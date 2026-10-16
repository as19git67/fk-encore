import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

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
import {
  ask,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  watchTurn,
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

  it("replays earlier turns with their tool calls and the digest of each result", async () => {
    clients.meter.listMeters.mockResolvedValue({ meters: [] });
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("list_meters", {}))
      .mockResolvedValueOnce(text("Keine Zähler."))
      .mockResolvedValueOnce(text("Immer noch keine."));
    const conv = await createConversation({});
    await ask({ id: conv.id, message: "Welche Zähler gibt es?" });
    await ask({ id: conv.id, message: "Und jetzt?" });

    const third = vi.mocked(chat).mock.calls[2][0];
    const replayed = third.messages.slice(1);
    expect(replayed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    const call = replayed[1] as { tool_calls: Array<{ id: string; function: { name: string } }> };
    expect(call.tool_calls[0]!.function.name).toBe("list_meters");
    // The result is the one-line digest, never the rows.
    expect(replayed[2]).toEqual({ role: "tool", tool_call_id: call.tool_calls[0]!.id, content: "[earlier result of list_meters: 0 rows]" });
    // The answer stays as written: no note the model could copy.
    expect(replayed[3]).toEqual({ role: "assistant", content: "Keine Zähler." });
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
