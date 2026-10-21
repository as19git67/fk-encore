import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import db from "../db/database";
import { assistantProposal } from "../db/schema";
import { calledEndpoints, clients, resetClients } from "./clients.test-helper";
import { executeAssistantProposal } from "./assistant";
import { HAND_TOOLS } from "./catalog";
import type { ToolContext } from "./types";

const PERMS = ["module.assistant", "module.photos", "photos.view", "photos.upload"];
const USER = 731;

const ctx = (previous?: number[]): ToolContext => ({
  user: { userID: String(USER), permissions: PERMS },
  today: "2026-10-21",
  previous: previous ? (type) => (type === "photo" ? previous : undefined) : undefined,
});

function tool(name: string) {
  const t = HAND_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function details(ids: number[]) {
  return {
    photos: ids.map((id) => ({
      id,
      filename: `2025/2025-06/p${id}.jpg`,
      mime_type: id === 99 ? "video/mp4" : "image/jpeg",
      auto_crop: id === 1 ? { x: 0.3, y: 0.4 } : null,
    })),
  };
}

beforeEach(async () => {
  await db.delete(assistantProposal);
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${USER}, ${`u${USER}@test.local`}, ${`User${USER}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
  resetClients();
  vi.mocked(getAuthData).mockReturnValue({ userID: String(USER), permissions: PERMS });
  clients.photo.getPhotoDetailsBatch.mockImplementation(async ({ ids }: { ids: string }) => details(ids.split(",").map(Number)));
});

describe("create_photo_collage", () => {
  it("is a write tool that needs the upload right", () => {
    expect(tool("create_photo_collage").kind).toBe("write");
    expect(tool("create_photo_collage").permissions).toContain("photos.upload");
  });

  it("proposes the collage with layout and caption, and renders nothing yet", async () => {
    const out = await tool("create_photo_collage").run(
      { photo_ids: [1, 2, 3], layout: "hero-top", text: "Sommer 2025", text_position: "bottom-right" },
      ctx(),
    );
    expect(calledEndpoints()).toEqual(["photo.getPhotoDetailsBatch"]);
    const row = out.block?.rows[0] as Record<string, any>;
    expect(row.summary).toBe("Collage aus 3 Fotos (Held oben) mit dem Text „Sommer 2025“ unten rechts als neues Foto ablegen");
    expect(row.collage).toMatchObject({
      layout: "hero-top",
      text: "Sommer 2025",
      text_position: "bottom-right",
      text_size: "medium",
      text_color: "#ffffff",
      result: null,
    });
    expect(row.collage.photos.map((p: { id: number }) => p.id)).toEqual([1, 2, 3]);
    expect(row.collage.photos[0].auto_crop).toEqual({ x: 0.3, y: 0.4 });
    // The model learns which other layouts there are.
    expect(out.text).toContain("cols (Spalten)");
    expect(out.text).toContain("NOT executed");
  });

  it("takes the photos of the previous answer and the first layout by default", async () => {
    const out = await tool("create_photo_collage").run({ from_previous_result: true }, ctx([4, 5, 6, 7]));
    expect((out.block?.rows[0] as Record<string, any>).collage.layout).toBe("grid");
  });

  it("refuses what cannot become a collage", async () => {
    const run = (args: Record<string, unknown>) => tool("create_photo_collage").run(args, ctx());
    await expect(run({ photo_ids: [1] })).rejects.toThrow("2 to 9 photos");
    await expect(run({ photo_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).rejects.toThrow("2 to 9 photos");
    await expect(run({ photo_ids: [1, 2], layout: "grid-3x3" })).rejects.toThrow("use one of side");
    await expect(run({ photo_ids: [1, 2], text: "x", text_position: "irgendwo" })).rejects.toThrow("text_position");
    await expect(run({ photo_ids: [1, 99] })).rejects.toThrow("video");
    clients.photo.getPhotoDetailsBatch.mockResolvedValueOnce(details([1]));
    await expect(run({ photo_ids: [1, 2] })).rejects.toThrow("photo 2 not found");
  });

  it("runs with the layout and caption changed on the card, files the photo and puts it into the album", async () => {
    clients.photo.listAlbums.mockResolvedValue({ albums: [{ id: 12, name: "Urlaub" }] });
    const out = await tool("create_photo_collage").run({ photo_ids: [1, 2], album_id: 12 }, ctx());
    const id = Number(out.block?.rows[0].proposal_id);
    expect(out.block?.rows[0].summary).toBe("Collage aus 2 Fotos (Nebeneinander) als Foto im Album „Urlaub“ ablegen");

    clients.photo.createPhotoCollage.mockResolvedValue({ photoId: 500, filename: "2025/2025-06/collage.jpg", layout: "stack", created: true });
    clients.photo.batchUpdateAlbumPhotos.mockResolvedValue({ success: true });
    const done = await executeAssistantProposal({
      id,
      edits: { collage: { layout: "stack", text: "Hallo", text_position: "top-left", text_size: "large" } },
    });

    expect(clients.photo.createPhotoCollage).toHaveBeenCalledWith({
      photoIds: [1, 2], layout: "stack", text: "Hallo", textPosition: "top-left", textSize: "large", textColor: "#ffffff",
    });
    expect(clients.photo.batchUpdateAlbumPhotos).toHaveBeenCalledWith({ albumIds: [12], photoIds: [500], action: "add" });
    expect(done).toMatchObject({
      status: "executed",
      result_route: "/fotos/alben/12",
      result_summary: "Collage aus 2 Fotos erstellt und ins Album „Urlaub“ gelegt",
    });
    expect(done.collage).toMatchObject({ layout: "stack", text: "Hallo", result: { photo_id: 500, filename: "2025/2025-06/collage.jpg" } });
  });

  it("keeps a bad change on the card as an error, and the proposal pending", async () => {
    const out = await tool("create_photo_collage").run({ photo_ids: [1, 2] }, ctx());
    const id = Number(out.block?.rows[0].proposal_id);
    const back = await executeAssistantProposal({ id, edits: { collage: { layout: "grid" } } });
    expect(back).toMatchObject({ status: "pending" });
    expect(back.error).toContain("unknown layout");
    expect(clients.photo.createPhotoCollage).not.toHaveBeenCalled();
  });
});
