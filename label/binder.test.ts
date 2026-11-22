import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users } from "../db/schema";
import * as binder from "./binder";
import {
  BINDER_SHEET,
  binderBlocks,
  contentFrame,
  labelOverflows,
  layoutBinderSheet,
  layoutLabelPdf,
  renderBinderBuffer,
} from "./binder-sheet";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let userId: number;
let otherId: number;

function setAuth(id: number, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(id), permissions: perms });
}

async function makeUser(tag: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({ email: `binder-${tag}-${Date.now()}-${Math.random()}@beispiel.test`, name: "Etiketten Test", password_hash: "x" })
    .returning({ id: users.id });
  return row!.id;
}

function fakeRequest(body: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
}

function fakeResponse() {
  const stream = new PassThrough();
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => stream.on("end", resolve));
  const res = Object.assign(stream, {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  });
  return { res: res as unknown as ServerResponse, headers, body: () => Buffer.concat(chunks), done, raw: res };
}

const LABELS = ["# Steuer\n## 2025", "**Versicherungen**\nHaus und Auto", "", "- Strom\n- Gas"];

beforeEach(async () => {
  userId = await makeUser("a");
  otherId = await makeUser("b");
  setAuth(userId, ["label.view", "label.print"]);
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, otherId));
  vi.restoreAllMocks();
});

describe("binder sheet layout", () => {
  it("puts four labels of 192 × 61 mm edge to edge, centred on A4", () => {
    const boxes = layoutBinderSheet();
    const mm = (pt: number) => (pt * 25.4) / 72;
    expect(boxes).toHaveLength(4);
    expect(mm(boxes[0]!.x)).toBeCloseTo(9, 5);
    expect(mm(boxes[0]!.y)).toBeCloseTo(26.5, 5);
    expect(mm(boxes[0]!.width)).toBeCloseTo(192, 5);
    expect(mm(boxes[0]!.height)).toBeCloseTo(61, 5);
    expect(mm(boxes[1]!.y - boxes[0]!.y)).toBeCloseTo(61, 5);
    // Left and right margins are equal, top and bottom too.
    expect(mm(boxes[0]!.x) * 2 + 192).toBeCloseTo(210, 5);
    expect(mm(boxes[3]!.y + boxes[3]!.height)).toBeCloseTo(297 - 26.5, 5);
  });

  it("turns the frame for a standing label", () => {
    const across = contentFrame("across");
    const along = contentFrame("along");
    expect(across.width).toBeCloseTo(along.height, 5);
    expect(across.height).toBeCloseTo(along.width, 5);
    expect(across.width).toBeLessThan(across.height);
  });

  it("reads headings, emphasis, line breaks and lists", () => {
    const blocks = binderBlocks("# Steuer\nzweite Zeile mit **fett** und *kursiv*\n\n- eins\n- zwei\n\n---");
    expect(blocks[0]).toMatchObject({ size: 30, runs: [{ text: "Steuer", bold: true }] });
    expect(blocks[1]!.runs.map((r) => r.text).join("")).toBe("zweite Zeile mit fett und kursiv");
    expect(blocks[1]!.runs.find((r) => r.text === "fett")?.bold).toBe(true);
    expect(blocks[1]!.runs.find((r) => r.text === "kursiv")?.italic).toBe(true);
    expect(blocks[2]).toMatchObject({ marker: "•", runs: [{ text: "eins" }] });
    expect(blocks[3]).toMatchObject({ marker: "•", runs: [{ text: "zwei" }] });
    expect(blocks[4]?.rule).toBe(true);
    // A single line break inside a paragraph stays a line break.
    expect(binderBlocks("eins\nzwei")[0]!.runs.map((r) => r.text)).toEqual(["eins", "\n", "zwei"]);
    expect(binderBlocks("   \n\n")).toEqual([]);
  });

  it("measures text and tells when it overflows", () => {
    expect(layoutLabelPdf("", "across", "center").height).toBe(0);
    expect(layoutLabelPdf("# Steuer", "across", "center").height).toBeCloseTo(30 * 1.25, 5);
    expect(labelOverflows("# Steuer", "across", "center")).toBe(false);
    const long = Array.from({ length: 30 }, (_, i) => `# Zeile ${i}`).join("\n");
    expect(labelOverflows(long, "along", "center")).toBe(true);
  });

  it("centres lines, keeps list items left and breaks long text", () => {
    const frame = contentFrame("across");
    const [title] = layoutLabelPdf("# Steuer", "across", "center").pieces;
    expect(title!.x * 2 + title!.width).toBeCloseTo(frame.width, 3);
    const left = layoutLabelPdf("# Steuer", "across", "left").pieces[0]!;
    expect(left.x).toBe(0);

    const list = layoutLabelPdf("- Strom", "across", "center").pieces;
    expect(list.map((p) => p.text)).toEqual(["•", "Strom"]);
    expect(list[1]!.x).toBe(14);

    const words = layoutLabelPdf("Belege und Bescheide aus allen Jahren seit dem Umzug", "across", "left").pieces;
    const lines = new Set(words.map((p) => p.baseline));
    expect(lines.size).toBeGreaterThan(1);
    for (const p of words) expect(p.x + p.width).toBeLessThanOrEqual(frame.width + 0.01);
  });

  it("sets a paragraph smaller when one word is wider than the label", () => {
    const frame = contentFrame("across");
    const [word] = layoutLabelPdf("# Versicherungsunterlagen", "across", "center").pieces;
    expect(word!.size).toBeLessThan(30);
    expect(word!.size).toBeGreaterThanOrEqual(8);
    expect(word!.width).toBeLessThanOrEqual(frame.width + 0.01);
  });

  it("centres a lying label vertically and starts a standing one at the top", () => {
    const along = layoutLabelPdf("# Steuer", "along", "center");
    const across = layoutLabelPdf("# Steuer", "across", "center");
    expect(along.pieces[0]!.baseline).toBeGreaterThan(across.pieces[0]!.baseline + 20);
  });

  it("shares its layout with the browser preview, byte for byte", () => {
    const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
    const server = readFileSync(here("./binder-layout.ts"), "utf8");
    const browser = readFileSync(here("../frontend/src/utils/binderLayout.ts"), "utf8");
    expect(browser).toBe(server);
  });

  it("renders a one-page PDF, even when a label overflows", async () => {
    const long = "Wort ".repeat(400);
    const pdf = await renderBinderBuffer({ labels: [...LABELS.slice(0, 3), long], direction: "across", align: "center", outlines: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const pages = pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? [];
    expect(pages).toHaveLength(1);
  });
});

describe("binder pages", () => {
  it("saves, lists, opens, changes and deletes a page", async () => {
    const created = await binder.createBinderPage({ name: "  Arbeitszimmer  ", labels: LABELS, direction: "across", align: "center" });
    expect(created.name).toBe("Arbeitszimmer");
    expect(created.labels).toEqual(LABELS);

    const { pages } = await binder.listBinderPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ id: created.id, name: "Arbeitszimmer", excerpt: "Steuer" });

    const opened = await binder.getBinderPage({ id: created.id });
    expect(opened).toMatchObject({ labels: LABELS, direction: "across", align: "center" });

    const changed = await binder.updateBinderPage({
      id: created.id,
      name: "Keller",
      labels: ["# Werkzeug"],
      direction: "along",
      align: "left",
    });
    expect(changed).toMatchObject({ name: "Keller", direction: "along", align: "left" });
    // Missing labels come back empty: a page always has four.
    expect(changed.labels).toEqual(["# Werkzeug", "", "", ""]);

    await binder.deleteBinderPage({ id: created.id });
    expect((await binder.listBinderPages()).pages).toHaveLength(0);
    await expect(binder.getBinderPage({ id: created.id })).rejects.toThrow(/nicht gefunden/);
  });

  it("keeps names unique per user, regardless of case", async () => {
    const first = await binder.createBinderPage({ name: "Büro", labels: LABELS, direction: "across", align: "center" });
    await expect(
      binder.createBinderPage({ name: "büro", labels: [], direction: "across", align: "center" }),
    ).rejects.toThrow(/gibt es schon/);
    const second = await binder.createBinderPage({ name: "Keller", labels: [], direction: "across", align: "center" });
    await expect(
      binder.updateBinderPage({ id: second.id, name: "BÜRO", labels: [], direction: "across", align: "center" }),
    ).rejects.toThrow(/gibt es schon/);
    // Saving a page under its own name is fine.
    await binder.updateBinderPage({ id: first.id, name: "Büro", labels: ["x"], direction: "across", align: "center" });

    setAuth(otherId, ["label.view"]);
    await binder.createBinderPage({ name: "Büro", labels: [], direction: "across", align: "center" });
  });

  it("refuses bad input", async () => {
    const base = { name: "X", labels: [] as string[], direction: "across" as const, align: "center" as const };
    await expect(binder.createBinderPage({ ...base, name: "   " })).rejects.toThrow(/Name/);
    await expect(binder.createBinderPage({ ...base, labels: ["a", "b", "c", "d", "e"] })).rejects.toThrow(/4 Etiketten/);
    await expect(binder.createBinderPage({ ...base, labels: ["x".repeat(2001)] })).rejects.toThrow(/2000 Zeichen/);
    await expect(binder.createBinderPage({ ...base, direction: "diagonal" as never })).rejects.toThrow(/Schreibrichtung/);
    await expect(binder.createBinderPage({ ...base, align: "right" as never })).rejects.toThrow(/Ausrichtung/);
  });

  it("never shows or touches another user's page", async () => {
    const page = await binder.createBinderPage({ name: "Privat", labels: LABELS, direction: "across", align: "center" });
    setAuth(otherId, ["label.view", "label.print"]);
    expect((await binder.listBinderPages()).pages).toHaveLength(0);
    await expect(binder.getBinderPage({ id: page.id })).rejects.toThrow(/nicht gefunden/);
    await expect(
      binder.updateBinderPage({ id: page.id, name: "Fremd", labels: [], direction: "across", align: "center" }),
    ).rejects.toThrow(/nicht gefunden/);
    await expect(binder.deleteBinderPage({ id: page.id })).rejects.toThrow(/nicht gefunden/);
  });

  it("needs label.view", async () => {
    setAuth(userId, []);
    await expect(binder.listBinderPages()).rejects.toThrow();
  });
});

describe("binder PDF endpoint", () => {
  it("renders what the page shows, saved or not", async () => {
    const { res, headers, body, done } = fakeResponse();
    await binder.binderPdf(fakeRequest({ name: "Büro/Regal", labels: LABELS, direction: "along", align: "left" }), res);
    await done;
    expect(headers["content-type"]).toBe("application/pdf");
    expect(decodeURIComponent(headers["content-disposition"]!)).toContain("Ordneretiketten Büro-Regal.pdf");
    expect(body().subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("needs label.print and checks the labels", async () => {
    setAuth(userId, ["label.view"]);
    const denied = fakeResponse();
    await binder.binderPdf(fakeRequest({ labels: LABELS }), denied.res);
    expect(denied.raw.statusCode).toBe(403);

    setAuth(userId, ["label.view", "label.print"]);
    const bad = fakeResponse();
    await binder.binderPdf(fakeRequest({ labels: ["a", "b", "c", "d", "e"] }), bad.res);
    expect(bad.raw.statusCode).toBe(400);
  });

  it("names the file after the page", () => {
    expect(binder.binderFilename("Steuer 2025")).toBe("Ordneretiketten Steuer 2025.pdf");
    expect(binder.binderFilename("")).toBe("Ordneretiketten.pdf");
    expect(BINDER_SHEET.labels).toBe(4);
  });
});
