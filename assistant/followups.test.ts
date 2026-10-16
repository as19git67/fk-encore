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
import { chat, type ChatReply } from "./llm-client";
import { __resetLiveTurnsForTests } from "./live";
import { __settleTitlesForTests, ask, createConversation, getConversation, listConversations } from "./assistant";
import { cleanTitle, fallbackTitle, suggestTitle } from "./titles";

const PERMS = [
  "module.assistant", "module.photos", "photos.view", "albums.manage", "module.finance", "finance.view",
];

function setAuth(userID: string) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: PERMS });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1))`,
  );
}

function toolCall(name: string, args: Record<string, unknown>, id = `c-${name}`): ChatReply {
  return { content: null, finish_reason: "tool_calls", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function text(content: string): ChatReply {
  return { content, tool_calls: [], finish_reason: "stop" };
}

const PHOTOS = [
  { id: 5, filename: "a.jpg", taken_at: "2025-06-01T10:00:00Z", location_city: "München", location_country: "Deutschland" },
  { id: 6, filename: "b.jpg", taken_at: "2025-07-01T10:00:00Z", location_city: "Musterstadt", location_country: "Deutschland" },
  { id: 7, filename: "c.jpg", taken_at: "2025-08-01T10:00:00Z", location_city: "München", location_country: "Deutschland" },
];

beforeEach(async () => {
  await db.delete(assistantProposal);
  await db.delete(assistantMessage);
  await db.delete(assistantConversation);
  await ensureUser(721);
  resetClients();
  vi.mocked(chat).mockReset();
  vi.mocked(suggestTitle).mockReset();
  vi.mocked(suggestTitle).mockResolvedValue(null);
  __resetRateLimiterForTests();
  __resetLiveTurnsForTests();
  setAuth("721");
});

async function askFavorites(conversationId: number) {
  clients.photo.listPhotos.mockResolvedValueOnce({ photos: PHOTOS });
  vi.mocked(chat)
    .mockResolvedValueOnce(toolCall("list_photos", { favorite: true, date_from: "2025-01-01", date_to: "2025-12-31" }))
    .mockResolvedValueOnce(text("Drei Favoriten aus 2025."));
  await ask({ id: conversationId, message: "Zeig meine Favoriten von 2025." });
}

describe("follow-up questions", () => {
  it("replay the tools behind an earlier answer, not its rows", async () => {
    const conversation = await createConversation({});
    await askFavorites(conversation.id);

    vi.mocked(chat).mockResolvedValueOnce(text("Das waren drei."));
    await ask({ id: conversation.id, message: "Wie viele waren das?" });

    const request = vi.mocked(chat).mock.calls.at(-1)![0];
    const earlier = request.messages.find((m) => m.role === "assistant" && m.content?.startsWith("Drei Favoriten"));
    expect(earlier?.content).toContain("[tools behind this answer: list_photos {\"favorite\":true,\"date_from\":\"2025-01-01\",\"date_to\":\"2025-12-31\"}");
    expect(earlier?.content).toContain("[earlier result of list_photos: 3 rows, ids 5,6,7]");
    // The rows themselves are not replayed.
    expect(request.messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("narrow the previous photos by place and make an album of them", async () => {
    const conversation = await createConversation({});
    await askFavorites(conversation.id);

    clients.photo.getPhotoDetailsBatch.mockResolvedValueOnce({ photos: PHOTOS });
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("list_photos", { from_previous_result: true, place: "münchen" }, "c-narrow"))
      .mockResolvedValueOnce(toolCall("create_album", { name: "München 2025", from_previous_result: true }, "c-album"))
      .mockResolvedValueOnce(text("Album vorgeschlagen."));
    const res = await ask({ id: conversation.id, message: "Nur die aus München, und mach daraus ein Album." });

    // No new search: the previous ids, narrowed by place.
    expect(clients.photo.listPhotos).toHaveBeenCalledTimes(1);
    expect(clients.photo.getPhotoDetailsBatch).toHaveBeenCalledWith({ ids: "5,6,7" });
    const narrowed = res.blocks.find((b) => b.kind === "photos");
    expect(narrowed?.rows.map((r) => r.id)).toEqual([5, 7]);
    expect(narrowed?.route).toBeUndefined();

    // The album takes the narrowed set, the latest photo result.
    const [proposal] = await db.select().from(assistantProposal);
    expect(proposal.arguments).toMatchObject({ name: "München 2025", photo_ids: [5, 7] });
  });

  it("intersect a new filter with the previous result", async () => {
    const conversation = await createConversation({});
    await askFavorites(conversation.id);

    clients.photo.listPhotos.mockResolvedValueOnce({ photos: [PHOTOS[1], PHOTOS[2], { id: 99, filename: "x.jpg" }] });
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("list_photos", { from_previous_result: true, date_from: "2025-07-01" }))
      .mockResolvedValueOnce(text("Zwei."));
    const res = await ask({ id: conversation.id, message: "Davon nur die ab Juli." });
    expect(res.blocks[0].rows.map((r) => r.id)).toEqual([6, 7]);
  });

  it("carry a booking result over to a later write", async () => {
    const conversation = await createConversation({});
    clients.finance.listTransactions.mockResolvedValueOnce({
      total: 2,
      items: [
        { id: 31, booking_date: "2026-09-01", amount: "-12.00", counterparty: "Bäckerei Beispiel", purpose: "Brot", tags: [] },
        { id: 32, booking_date: "2026-09-02", amount: "-8.50", counterparty: "Bäckerei Beispiel", purpose: "Brötchen", tags: [] },
      ],
    });
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("list_transactions", { q: "Bäckerei" }))
      .mockResolvedValueOnce(text("Zwei Buchungen."));
    await ask({ id: conversation.id, message: "Buchungen bei der Bäckerei?" });

    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("tag_transactions", { from_previous_result: true, add: ["Lebensmittel"] }))
      .mockResolvedValueOnce(text("Vorgeschlagen."));
    await ask({ id: conversation.id, message: "Tagge die mit Lebensmittel." });

    const [proposal] = await db.select().from(assistantProposal);
    expect(proposal.arguments).toMatchObject({ transaction_ids: [31, 32], add: ["Lebensmittel"] });
    expect(proposal.summary).toBe("Bei 2 Buchungen „Lebensmittel“ setzen");
  });

  it("say so when there is no earlier result", async () => {
    const conversation = await createConversation({});
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("create_album", { name: "Leer", from_previous_result: true }))
      .mockResolvedValueOnce(text("Dazu gibt es noch kein Ergebnis."));
    await ask({ id: conversation.id, message: "Mach daraus ein Album." });

    const toolMessage = vi.mocked(chat).mock.calls[1][0].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("there is no earlier photo result in this conversation");
    expect(await db.select().from(assistantProposal)).toHaveLength(0);
  });

  it("keep results to their own conversation", async () => {
    const first = await createConversation({});
    await askFavorites(first.id);
    const second = await createConversation({});
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("set_photo_favorite", { from_previous_result: true, favorite: false }))
      .mockResolvedValueOnce(text("Nichts gefunden."));
    await ask({ id: second.id, message: "Nimm bei denen den Favoriten weg." });
    expect(await db.select().from(assistantProposal)).toHaveLength(0);
  });
});

describe("conversation titles", () => {
  it("come from the model after the first answer and replace only the fallback", async () => {
    vi.mocked(suggestTitle).mockResolvedValueOnce("Favoriten 2025");
    const conversation = await createConversation({});
    await askFavorites(conversation.id);
    await __settleTitlesForTests();

    expect((await getConversation({ id: conversation.id })).title).toBe("Favoriten 2025");
    expect(suggestTitle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(suggestTitle).mock.calls[0][1]).toBe("Zeig meine Favoriten von 2025.");

    vi.mocked(chat).mockResolvedValueOnce(text("Ja."));
    await ask({ id: conversation.id, message: "Noch etwas?" });
    await __settleTitlesForTests();
    expect(suggestTitle).toHaveBeenCalledTimes(1);
  });

  it("keep the question as title when naming fails", async () => {
    vi.mocked(suggestTitle).mockRejectedValueOnce(new Error("model busy"));
    const conversation = await createConversation({});
    await askFavorites(conversation.id);
    await __settleTitlesForTests();
    const [row] = await db.select().from(assistantConversation).where(eq(assistantConversation.id, conversation.id));
    expect(row.title).toBe("Zeig meine Favoriten von 2025.");
    expect((await listConversations()).conversations[0].title).toBe("Zeig meine Favoriten von 2025.");
  });

  it("are cleaned of quotes, labels and full stops", () => {
    expect(cleanTitle("„Favoriten 2025“")).toBe("Favoriten 2025");
    expect(cleanTitle("Titel: Stromverbrauch im Vorjahr.")).toBe("Stromverbrauch im Vorjahr");
    expect(cleanTitle("\n\n Lastschriften Oktober\nweitere Zeile")).toBe("Lastschriften Oktober");
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("x".repeat(80))?.length).toBe(60);
    expect(fallbackTitle("  Wie   viel\nStrom? ")).toBe("Wie viel Strom?");
  });
});
