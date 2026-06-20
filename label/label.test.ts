import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { getLabelPrefs, setLabelPrefs, listPrinters, getCupsBaseUrl } from "./label.service";
import * as endpoints from "./label";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

// Minimal IPP response fixtures.
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function ippHeader(status: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt8(2, 0);
  b.writeUInt8(0, 1);
  b.writeUInt16BE(status, 2);
  b.writeUInt32BE(1, 4);
  return b;
}

function strAttr(tag: number, name: string, value: string): Buffer {
  const n = Buffer.from(name, "utf8");
  const v = Buffer.from(value, "utf8");
  const nl = Buffer.alloc(2);
  nl.writeUInt16BE(n.length);
  const vl = Buffer.alloc(2);
  vl.writeUInt16BE(v.length);
  return Buffer.concat([Buffer.from([tag]), nl, n, vl, v]);
}

function getPrintersResponse(names: string[]): Buffer {
  const parts = [ippHeader(0x0000), Buffer.from([0x01])];
  parts.push(strAttr(0x47, "attributes-charset", "utf-8"));
  for (const name of names) {
    parts.push(Buffer.from([0x04])); // printer-attributes group
    parts.push(strAttr(0x42, "printer-name", name));
    const stateBuf = Buffer.concat([
      Buffer.from([0x23]),
      (() => {
        const nl = Buffer.alloc(2);
        nl.writeUInt16BE("printer-state".length);
        return Buffer.concat([nl, Buffer.from("printer-state")]);
      })(),
      (() => {
        const vl = Buffer.alloc(2);
        vl.writeUInt16BE(4);
        const v = Buffer.alloc(4);
        v.writeInt32BE(3);
        return Buffer.concat([vl, v]);
      })(),
    ]);
    parts.push(stateBuf);
  }
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}

function okResponse(buf: Buffer) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: () => Promise.resolve(toArrayBuffer(buf)),
  } as unknown as Response);
}

let userId: number;
const originalFetch = global.fetch;

beforeEach(async () => {
  const [row] = await db
    .insert(users)
    .values({
      email: `label-test-${Date.now()}-${Math.random()}@example.com`,
      name: "Label Tester",
      password_hash: "x",
    })
    .returning({ id: users.id });
  userId = row.id;
  setAuth(String(userId), ["label.view", "label.print"]);
});

afterEach(async () => {
  await db.delete(users).where(eq(users.id, userId));
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("label.service — preferences", () => {
  it("returns an empty object when nothing is stored", async () => {
    expect(await getLabelPrefs(userId)).toEqual({});
  });

  it("round-trips the selected printer", async () => {
    await setLabelPrefs(userId, { printer: "DYMO_LabelWriter_450" });
    expect(await getLabelPrefs(userId)).toEqual({ printer: "DYMO_LabelWriter_450" });
  });
});

describe("label.service — listPrinters", () => {
  it("parses the CUPS printer list", async () => {
    global.fetch = vi.fn(() => okResponse(getPrintersResponse(["A", "B"]))) as any;
    const printers = await listPrinters();
    expect(printers.map((p) => p.name)).toEqual(["A", "B"]);
    expect(printers[0].state).toBe(3);
  });

  it("throws unavailable when the CUPS server is unreachable", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))) as any;
    await expect(listPrinters()).rejects.toThrow(/nicht erreichbar/);
  });

  it("surfaces the underlying cause code (e.g. ENOTFOUND)", async () => {
    const wrapped = Object.assign(new Error("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
    global.fetch = vi.fn(() => Promise.reject(wrapped)) as any;
    await expect(listPrinters()).rejects.toThrow(/ENOTFOUND/);
  });
});

describe("label.service — getCupsBaseUrl", () => {
  const original = process.env.CUPS_SERVER_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.CUPS_SERVER_URL;
    else process.env.CUPS_SERVER_URL = original;
  });

  it("prepends http:// when the scheme is missing", () => {
    process.env.CUPS_SERVER_URL = "scanner.schegg.net:631";
    expect(getCupsBaseUrl()).toBe("http://scanner.schegg.net:631");
  });

  it("keeps an explicit scheme and strips a trailing slash", () => {
    process.env.CUPS_SERVER_URL = "https://cups.local:631/";
    expect(getCupsBaseUrl()).toBe("https://cups.local:631");
  });
});

describe("label endpoints", () => {
  it("listPrinters returns printers and the saved selection", async () => {
    await setLabelPrefs(userId, { printer: "A" });
    global.fetch = vi.fn(() => okResponse(getPrintersResponse(["A", "B"]))) as any;
    const res = await endpoints.listPrinters();
    expect(res.printers.map((p) => p.name)).toEqual(["A", "B"]);
    expect(res.selected).toBe("A");
    expect(res.cupsError).toBeNull();
  });

  it("listPrinters surfaces a CUPS error instead of throwing", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("boom"))) as any;
    const res = await endpoints.listPrinters();
    expect(res.printers).toEqual([]);
    expect(res.cupsError).toContain("nicht erreichbar");
  });

  it("savePrinter persists the selection", async () => {
    const res = await endpoints.savePrinter({ printer: "  DYMO  " });
    expect(res.selected).toBe("DYMO");
    expect(await getLabelPrefs(userId)).toEqual({ printer: "DYMO" });
  });

  it("print rejects when no printer is selected", async () => {
    await expect(endpoints.print({ text: "hi" })).rejects.toMatchObject({
      code: "failed_precondition",
    });
  });

  it("print rejects empty text", async () => {
    await expect(endpoints.print({ text: "   ", printer: "A" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("print submits the job and remembers an explicit printer", async () => {
    const fetchMock = vi.fn(() => okResponse(ippHeader(0x0000)));
    global.fetch = fetchMock as any;
    const res = await endpoints.print({ text: "Hallo", copies: 2, printer: "A" });
    expect(res).toEqual({ printed: 2, printer: "A" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getLabelPrefs(userId)).toEqual({ printer: "A" });
  });

  it("print requires the label.print permission", async () => {
    setAuth(String(userId), ["label.view"]);
    await expect(endpoints.print({ text: "x", printer: "A" })).rejects.toMatchObject({
      code: "permission_denied",
    });
  });
});
