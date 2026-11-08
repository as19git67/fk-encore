import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users } from "../db/schema";
import * as scanner from "./scanner";
import { LABELS_PER_PAGE, SHEET, labelText, layoutSheet, renderSheetBuffer } from "./scanner-sheet";

let userId: number;

function setAuth(perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions: perms });
}

/** A ServerResponse stand-in that collects what the raw endpoint writes. */
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

beforeEach(async () => {
  const [row] = await db
    .insert(users)
    .values({ email: `scanner-${Date.now()}-${Math.random()}@beispiel.test`, name: "Etiketten Test", password_hash: "x" })
    .returning({ id: users.id });
  userId = row!.id;
  setAuth(["label.view", "label.print"]);
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
  vi.restoreAllMocks();
});

describe("scanner sheet layout", () => {
  it("fills Avery L4731REV row by row: 7 × 27 labels of 25.4 × 10 mm", () => {
    const boxes = layoutSheet({ firstNumber: 1, pages: 1 });
    expect(boxes).toHaveLength(189);
    expect(boxes[0]!.text).toBe("#0001");
    expect(boxes[6]!.text).toBe("#0007");
    expect(boxes[7]!.text).toBe("#0008");
    expect(boxes.at(-1)!.text).toBe("#0189");

    const mm = (pt: number) => (pt * 25.4) / 72;
    expect(mm(boxes[0]!.x)).toBeCloseTo(8.6, 5);
    expect(mm(boxes[0]!.y)).toBeCloseTo(13.5, 5);
    expect(mm(boxes[1]!.x - boxes[0]!.x)).toBeCloseTo(27.9, 5);
    expect(mm(boxes[7]!.y - boxes[0]!.y)).toBeCloseTo(10, 5);
    const last = boxes.at(-1)!;
    // The grid ends inside the page with the same margin it starts with.
    expect(mm(last.x + last.width)).toBeCloseTo(210 - 8.6, 5);
    expect(mm(last.y + last.height)).toBeCloseTo(297 - 13.5, 5);
  });

  it("moves the whole grid by the offset", () => {
    const plain = layoutSheet({ firstNumber: 1, pages: 1 })[0]!;
    const moved = layoutSheet({ firstNumber: 1, pages: 1, offsetXMm: 1, offsetYMm: -2 })[0]!;
    expect(((moved.x - plain.x) * 25.4) / 72).toBeCloseTo(1, 5);
    expect(((moved.y - plain.y) * 25.4) / 72).toBeCloseTo(-2, 5);
  });

  it("pads to four digits and grows beyond", () => {
    expect(labelText(7)).toBe("#0007");
    expect(labelText(12345)).toBe("#12345");
  });

  it("renders one page per sheet page", async () => {
    const pdf = await renderSheetBuffer({ firstNumber: 1, pages: 2 });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)).toHaveLength(2);
    expect(SHEET.columns * SHEET.rows).toBe(LABELS_PER_PAGE);
  });
});

describe("scanner endpoints", () => {
  it("starts at #0001 and continues where the last sheet ended", async () => {
    const empty = await scanner.scannerOverview();
    expect(empty.nextNumber).toBe(1);
    expect(empty.sheets).toEqual([]);

    const a = await scanner.createScannerSheet({});
    expect(a.sheet.range).toBe("#0001 – #0189");
    expect(a.nextNumber).toBe(190);

    const b = await scanner.createScannerSheet({ pages: 2 });
    expect(b.sheet.firstNumber).toBe(190);
    expect(b.sheet.lastNumber).toBe(190 + 2 * 189 - 1);

    const overview = await scanner.scannerOverview();
    expect(overview.nextNumber).toBe(b.nextNumber);
    expect(overview.sheets.map((s) => s.id)).toEqual([b.sheet.id, a.sheet.id]);
  });

  it("takes consecutive ranges when two sheets are created at once", async () => {
    const [x, y] = await Promise.all([scanner.createScannerSheet({}), scanner.createScannerSheet({})]);
    const firsts = [x.sheet.firstNumber, y.sheet.firstNumber].sort((p, q) => p - q);
    expect(firsts).toEqual([1, 190]);
  });

  it("continues from a number set by hand and keeps other label settings", async () => {
    await db.update(users).set({ label_prefs: { printer: "Dymo" } }).where(eq(users.id, userId));
    const saved = await scanner.saveScannerSettings({ nextNumber: 1234, offsetXMm: 0.5 });
    expect(saved).toEqual({ nextNumber: 1234, offsetXMm: 0.5, offsetYMm: 0 });
    const created = await scanner.createScannerSheet({});
    expect(created.sheet.range).toBe("#1234 – #1422");
    const [row] = await db.select({ prefs: users.label_prefs }).from(users).where(eq(users.id, userId));
    expect(row!.prefs).toMatchObject({ printer: "Dymo", scannerNextNumber: 1423, scannerOffsetXMm: 0.5 });
  });

  it("rejects bad input", async () => {
    await expect(scanner.createScannerSheet({ pages: 0 })).rejects.toThrow();
    await expect(scanner.createScannerSheet({ pages: 11 })).rejects.toThrow();
    await expect(scanner.saveScannerSettings({ nextNumber: 0 })).rejects.toThrow();
    await expect(scanner.saveScannerSettings({ offsetYMm: 11 })).rejects.toThrow();
  });

  it("needs label.print to use up numbers", async () => {
    setAuth(["label.view"]);
    await expect(scanner.createScannerSheet({})).rejects.toThrow();
    await expect(scanner.saveScannerSettings({ nextNumber: 5 })).rejects.toThrow();
    expect((await scanner.scannerOverview()).nextNumber).toBe(1);
  });

  it("serves the sheet as PDF and only to its owner", async () => {
    const { sheet } = await scanner.createScannerSheet({});
    const out = fakeResponse();
    await scanner.scannerSheetPdf(
      { url: `/label/scanner/sheets/${sheet.id}/pdf` } as IncomingMessage,
      out.res,
    );
    await out.done;
    expect(out.raw.statusCode).toBe(200);
    expect(out.headers["content-type"]).toBe("application/pdf");
    expect(out.headers["content-disposition"]).toContain("Scanner-Etiketten 0001-0189.pdf");
    expect(out.body().subarray(0, 5).toString()).toBe("%PDF-");

    const [other] = await db
      .insert(users)
      .values({ email: `scanner-other-${Date.now()}@beispiel.test`, name: "Andere", password_hash: "x" })
      .returning({ id: users.id });
    try {
      vi.mocked(getAuthData).mockReturnValue({ userID: String(other!.id), permissions: ["label.view"] });
      const denied = fakeResponse();
      await scanner.scannerSheetPdf(
        { url: `/label/scanner/sheets/${sheet.id}/pdf` } as IncomingMessage,
        denied.res,
      );
      expect(denied.raw.statusCode).toBe(404);
    } finally {
      await db.delete(users).where(eq(users.id, other!.id));
    }
  });

  it("removes a sheet from the list without giving its numbers back", async () => {
    const { sheet } = await scanner.createScannerSheet({});
    await scanner.deleteScannerSheet({ id: sheet.id });
    const overview = await scanner.scannerOverview();
    expect(overview.sheets).toEqual([]);
    expect(overview.nextNumber).toBe(190);
    await expect(scanner.deleteScannerSheet({ id: sheet.id })).rejects.toThrow();
  });
});
