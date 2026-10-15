import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("./llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./llm-client")>();
  return { ...real, chat: vi.fn() };
});

import db from "../db/database";
import { assistantConversation, assistantMessage, assistantProposal } from "../db/schema";
import { __resetRateLimiterForTests } from "../user/rateLimiter";
import { calledEndpoints, clients, resetClients } from "./clients.test-helper";
import { chat, type ChatReply } from "./llm-client";
import { __resetLiveTurnsForTests } from "./live";
import {
  ask,
  createConversation,
  discardAssistantProposal,
  executeAssistantProposal,
  getConversation,
} from "./assistant";
import { HAND_TOOLS } from "./catalog";
import type { ToolContext } from "./types";

const PERMS = [
  "module.assistant", "module.photos", "photos.view", "albums.manage",
  "module.documents", "documents.view", "module.finance", "finance.view",
];

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

const ctx = (userID = "711", permissions = PERMS): ToolContext => ({ user: { userID, permissions }, today: "2026-10-15" });

function tool(name: string) {
  const t = HAND_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeEach(async () => {
  await db.delete(assistantProposal);
  await db.delete(assistantMessage);
  await db.delete(assistantConversation);
  await ensureUser(711);
  await ensureUser(712);
  resetClients();
  vi.mocked(chat).mockReset();
  __resetRateLimiterForTests();
  __resetLiveTurnsForTests();
  setAuth("711");
});

describe("write tools", () => {
  it("are in the catalog as proposals", () => {
    for (const name of ["create_album", "add_photos_to_album", "set_photo_favorite", "create_document_follow_up", "tag_transactions"]) {
      expect(tool(name).kind).toBe("write");
    }
  });

  it("an album request becomes a proposal and nothing is created", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 5 }, { id: 6 }, { id: 7 }] });
    const conversation = await createConversation({});
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("create_album", {
        name: "Favoriten 2025",
        photos: { favorite: true, date_from: "2025-01-01", date_to: "2025-12-31" },
      }))
      .mockResolvedValueOnce(text("Ich habe das Album „Favoriten 2025“ mit 3 Fotos vorgeschlagen."));

    const res = await ask({ id: conversation.id, message: "Leg ein Album mit allen Favoriten von 2025 an." });

    expect(calledEndpoints()).toEqual(["photo.listPhotos"]);
    expect(clients.photo.listPhotos.mock.calls[0][0]).toMatchObject({ favorite: true, dateFrom: "2025-01-01", dateTo: "2025-12-31" });
    const block = res.blocks.find((b) => b.kind === "proposal");
    expect(block?.rows[0]).toMatchObject({
      tool: "create_album",
      summary: "Album „Favoriten 2025“ anlegen und 3 Fotos hinzufügen",
      count: 3,
      status: "pending",
    });
    const [stored] = await db.select().from(assistantProposal);
    expect(stored).toMatchObject({ conversation_id: conversation.id, user_id: 711, status: "pending" });
    expect(stored.arguments).toMatchObject({ name: "Favoriten 2025", photo_ids: [5, 6, 7] });

    // The tool result tells the model it is only a proposal.
    const second = vi.mocked(chat).mock.calls[1][0];
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("NOT executed");
  });

  it("refuses a selection that names no photos", async () => {
    await expect(tool("add_photos_to_album").run({ album_id: 1 }, ctx())).rejects.toThrow();
  });

  it("refuses a follow-up in the past", async () => {
    await expect(tool("create_document_follow_up").run({ document_ids: [1], date: "2026-10-01" }, ctx()))
      .rejects.toThrow("past");
  });
});

describe("deciding", () => {
  async function albumProposal(): Promise<number> {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 5 }, { id: 6 }] });
    const out = await tool("create_album").run({ name: "Sommer", photos: { favorite: true } }, ctx());
    return Number(out.block?.rows[0].proposal_id);
  }

  it("executes once, through the services' endpoints", async () => {
    const id = await albumProposal();
    clients.photo.createAlbum.mockResolvedValue({ id: 42, name: "Sommer" });
    clients.photo.batchUpdateAlbumPhotos.mockResolvedValue({ success: true });

    const done = await executeAssistantProposal({ id });
    expect(done).toMatchObject({ status: "executed", result_route: "/fotos/alben/42", error: null });
    expect(clients.photo.createAlbum).toHaveBeenCalledWith({ name: "Sommer", description: undefined });
    expect(clients.photo.batchUpdateAlbumPhotos).toHaveBeenCalledWith({ albumIds: [42], photoIds: [5, 6], action: "add" });

    await expect(executeAssistantProposal({ id })).rejects.toThrow("already executed");
    await expect(discardAssistantProposal({ id })).rejects.toThrow("already executed");
    expect(clients.photo.createAlbum).toHaveBeenCalledTimes(1);
  });

  it("is not visible to another user", async () => {
    const id = await albumProposal();
    setAuth("712");
    await expect(executeAssistantProposal({ id })).rejects.toThrow("proposal not found");
    await expect(discardAssistantProposal({ id })).rejects.toThrow("proposal not found");
    expect(clients.photo.createAlbum).not.toHaveBeenCalled();
  });

  it("a failure stays pending with its error and can be retried", async () => {
    const id = await albumProposal();
    clients.photo.createAlbum.mockRejectedValueOnce(new Error("album name taken"));
    const failed = await executeAssistantProposal({ id });
    expect(failed).toMatchObject({ status: "pending", error: "album name taken" });

    clients.photo.createAlbum.mockResolvedValue({ id: 43, name: "Sommer" });
    clients.photo.batchUpdateAlbumPhotos.mockResolvedValue({ success: true });
    expect((await executeAssistantProposal({ id })).status).toBe("executed");
  });

  it("re-checks permissions at execution", async () => {
    const id = await albumProposal();
    setAuth("711", PERMS.filter((p) => p !== "albums.manage"));
    const res = await executeAssistantProposal({ id });
    expect(res.status).toBe("pending");
    expect(res.error).toContain("permission");
    expect(clients.photo.createAlbum).not.toHaveBeenCalled();
  });

  it("discarding leaves everything untouched, and the reopened conversation shows it", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 5 }] });
    const conversation = await createConversation({});
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("create_album", { name: "Herbst", photo_ids: [5] }))
      .mockResolvedValueOnce(text("Vorgeschlagen."));
    const res = await ask({ id: conversation.id, message: "Album Herbst mit Foto 5" });
    const id = Number(res.blocks.find((b) => b.kind === "proposal")?.rows[0].proposal_id);

    expect((await discardAssistantProposal({ id })).status).toBe("discarded");
    expect(calledEndpoints()).toEqual([]);

    const reopened = await getConversation({ id: conversation.id });
    const card = reopened.messages.at(-1)?.blocks.find((b) => b.kind === "proposal")?.rows[0];
    expect(card).toMatchObject({ status: "discarded", count: 1 });
  });

  it("tags bookings and sets follow-ups through their endpoints", async () => {
    const tagged = await tool("tag_transactions").run({ transaction_ids: [1, 2], add: ["Urlaub"] }, ctx());
    clients.finance.batchTag.mockResolvedValue({ affected_transactions: 2, added_links: 2, removed_links: 0 });
    const tagRes = await executeAssistantProposal({ id: Number(tagged.block?.rows[0].proposal_id) });
    expect(tagRes.status).toBe("executed");
    expect(clients.finance.batchTag).toHaveBeenCalledWith({ transaction_ids: [1, 2], add: ["Urlaub"], remove: [] });

    const follow = await tool("create_document_follow_up").run({ document_ids: [9], date: "2026-11-02", note: "Frist" }, ctx());
    clients.documents.setDocumentFollowUp.mockResolvedValue({ scheduled: 1 });
    const followRes = await executeAssistantProposal({ id: Number(follow.block?.rows[0].proposal_id) });
    expect(followRes).toMatchObject({ status: "executed", result_route: "/dokumente/spaeter" });
    expect(clients.documents.setDocumentFollowUp).toHaveBeenCalledWith({ document_ids: [9], follow_up_date: "2026-11-02", note: "Frist" });
  });
});
