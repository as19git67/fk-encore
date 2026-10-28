/**
 * Hidden photos (Ausgeblendet) stay out of every photo tool unless the
 * model passes `hidden`, which it does only when the user asks for them.
 * Services are mocked; data is synthetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import { clients, resetClients } from "./clients.test-helper";
import { HAND_TOOLS } from "./catalog";
import { TOOL_ALLOWLIST } from "./tool-allowlist";
import { WRITE_TOOLS_BY_NAME } from "./tools/writes";
import { passesHidden } from "./tools/photos";
import type { ToolContext } from "./types";

const PERMS = ["module.photos", "photos.view", "albums.manage", "module.assistant"];
const ctx = (previous?: number[]): ToolContext => ({
  user: { userID: "711", permissions: PERMS },
  today: "2026-10-15",
  previous: previous ? () => previous : undefined,
});

function tool(name: string) {
  const t = HAND_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeEach(() => resetClients());

describe("passesHidden", () => {
  it("keeps hidden photos out by default, adds them on include, keeps only them on only", () => {
    expect(passesHidden("hidden", "exclude")).toBe(false);
    expect(passesHidden(null, "exclude")).toBe(true);
    expect(passesHidden("favorite", "exclude")).toBe(true);
    expect(passesHidden("hidden", "include")).toBe(true);
    expect(passesHidden("visible", "include")).toBe(true);
    expect(passesHidden("hidden", "only")).toBe(true);
    expect(passesHidden(undefined, "only")).toBe(false);
  });
});

describe("list_photos", () => {
  it("asks the server without hidden photos unless told otherwise", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [] });
    const out = await tool("list_photos").run({ date_from: "2024-01-01" }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenCalledWith(expect.objectContaining({ hiddenMode: "exclude" }));
    expect(out.text).toContain("hidden photos left out");
  });

  it("includes hidden photos, or only them, when the model says so, and links the gallery the same way", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 3 }] });
    const out = await tool("list_photos").run({ date_from: "2024-01-01", hidden: "include" }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ hiddenMode: "include" }));
    expect(out.text).toContain("hidden photos included");
    expect(out.block?.route).toContain("hiddenMode=include");

    await tool("list_photos").run({ hidden: "only" }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ hiddenMode: "only" }));
  });

  it("treats an unknown value as leaving hidden photos out", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [] });
    await tool("list_photos").run({ hidden: "yes" }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenCalledWith(expect.objectContaining({ hiddenMode: "exclude" }));
  });

  it("drops hidden photos when it re-reads a previous result by id", async () => {
    clients.photo.getPhotoDetailsBatch.mockResolvedValue({ photos: [
      { id: 1, curation_status: "visible" }, { id: 2, curation_status: "hidden" }, { id: 3 },
    ] });
    const out = await tool("list_photos").run({ from_previous_result: true, rank_by: "quality", direction: "desc" }, ctx([1, 2, 3]));
    expect(clients.photo.listPhotos).not.toHaveBeenCalled();
    expect(out.ref?.ids.sort()).toEqual([1, 3]);

    const withHidden = await tool("list_photos").run({ from_previous_result: true, hidden: "include" }, ctx([1, 2, 3]));
    expect(withHidden.ref?.ids).toEqual([1, 2, 3]);
  });
});

describe("search_photos", () => {
  it("searches without hidden photos by default and with them on request", async () => {
    clients.photo.searchPhotosNatural.mockResolvedValue({ results: [] });
    await tool("search_photos").run({ query: "Strand" }, ctx());
    expect(clients.photo.searchPhotosNatural).toHaveBeenLastCalledWith(expect.objectContaining({ hiddenMode: "exclude" }));
    await tool("search_photos").run({ query: "Strand", hidden: "include" }, ctx());
    expect(clients.photo.searchPhotosNatural).toHaveBeenLastCalledWith(expect.objectContaining({ hiddenMode: "include" }));
  });
});

describe("list_persons", () => {
  it("counts no faces on hidden photos unless asked to", async () => {
    clients.photo.listPersons.mockResolvedValue({ persons: [] });
    const entry = TOOL_ALLOWLIST.find((e) => e.name === "list_persons")!;
    await entry.invoke({});
    expect(clients.photo.listPersons).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: "exclude" }));
    await entry.invoke({ hidden: "include" });
    expect(clients.photo.listPersons).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: "include" }));
  });
});

describe("photo selections of write tools", () => {
  it("create_album by filter leaves hidden photos out, and takes them only when asked", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 1 }, { id: 2 }] });
    const createAlbum = WRITE_TOOLS_BY_NAME.get("create_album")!;
    await createAlbum.prepare({ name: "Favoriten 2025", photos: { favorite: true } }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ favorite: true, hiddenMode: "exclude" }));

    const only = await createAlbum.prepare({ name: "Ausgeblendet", photos: { hidden: "only" } }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ hiddenMode: "only" }));
    expect(only.count).toBe(2);
  });
});
