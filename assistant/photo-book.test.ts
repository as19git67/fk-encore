import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import db from "../db/database";
import { assistantProposal } from "../db/schema";
import { calledEndpoints, clients, resetClients } from "./clients.test-helper";
import { executeAssistantProposal } from "./assistant";
import { HAND_TOOLS } from "./catalog";
import { homeOf } from "./areas";
import type { ToolContext } from "./types";

const PERMS = ["module.assistant", "module.photos", "photos.view"];
const USER = 733;

const ctx = (previous?: number[]): ToolContext => ({
  user: { userID: String(USER), permissions: PERMS },
  today: "2026-10-26",
  previous: previous ? (type) => (type === "photo" ? previous : undefined) : undefined,
});

function tool() {
  const t = HAND_TOOLS.find((x) => x.name === "create_photo_book");
  if (!t) throw new Error("no tool create_photo_book");
  return t;
}

beforeEach(async () => {
  await db.delete(assistantProposal);
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${USER}, ${`u${USER}@test.local`}, ${`User${USER}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
  resetClients();
  vi.mocked(getAuthData).mockReturnValue({ userID: String(USER), permissions: PERMS });
});

describe("create_photo_book", () => {
  it("is a write tool of the photos area", () => {
    expect(tool().kind).toBe("write");
    expect(homeOf("create_photo_book")).toBe("photos");
  });

  it("proposes a book from the previous answer with the narrowing in its own arguments, and builds nothing yet", async () => {
    const out = await tool().run(
      { title: "Sommer 2025", from_previous_result: true, max_photos: 80, weights: { landscape: 1, people: 0 }, without_recognisable_faces: true },
      ctx([11, 12, 13]),
    );
    expect(calledEndpoints()).toEqual([]);
    const row = out.block?.rows[0] as Record<string, unknown>;
    expect(row.summary).toBe("Fotobuch „Sommer 2025“ aus 3 Fotos gestalten (A4 quer, ohne erkennbare Gesichter, höchstens 80 Fotos, mehr Landschaft)");
    expect(out.text).toContain("NOT executed");

    clients.photo.createPhotoBookApi.mockResolvedValue({ id: 41, title: "Sommer 2025", page_count: 6, photo_count: 3 });
    const done = await executeAssistantProposal({ id: Number(row.proposal_id) });
    expect(clients.photo.createPhotoBookApi).toHaveBeenCalledWith({
      title: "Sommer 2025",
      subtitle: null,
      format: "a4-landscape",
      photoIds: [11, 12, 13],
      qualityMin: null,
      aestheticMin: null,
      withoutRecognisableFaces: true,
      maxPhotos: 80,
      weights: { landscape: 1 },
    });
    expect(done).toMatchObject({ status: "executed", result_route: "/fotos/fotobuecher/41" });
  });

  it("takes an album the user can see, and refuses what names no photos", async () => {
    clients.photo.listAlbums.mockResolvedValue({ albums: [{ id: 5, name: "Ausflug" }] });
    const out = await tool().run({ title: "Ausflug", album_id: 5, format: "square-21" }, ctx());
    expect((out.block?.rows[0] as Record<string, unknown>).summary).toBe("Fotobuch „Ausflug“ aus dem Album „Ausflug“ gestalten (Quadrat 21 × 21 cm)");
    await expect(tool().run({ title: "X", album_id: 6 }, ctx())).rejects.toThrow("album 6 not found");
    await expect(tool().run({ title: "X" }, ctx())).rejects.toThrow("say which photos");
    await expect(tool().run({ title: "X", from_previous_result: true }, ctx())).rejects.toThrow("no earlier photo result");
    await expect(tool().run({ title: "X", photo_ids: [1], format: "a5" }, ctx())).rejects.toThrow("unknown format");
  });
});
