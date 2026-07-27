import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  getLabelPrefs,
  setLabelPrefs,
  listPrinters,
  getCupsBaseUrl,
} from "./label.service";
import type * as svc from "./label.service";
import * as endpoints from "./label";

// A minimal byte sequence that starts with the PNG signature — enough to pass
// the endpoint's PNG validation. Base64-encoded as the API expects.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PNG_B64 = PNG_BYTES.toString("base64");

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

// ── IPP response byte fixtures ───────────────────────────────────────────────

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
    const nl = Buffer.alloc(2);
    nl.writeUInt16BE("printer-state".length);
    const vl = Buffer.alloc(2);
    vl.writeUInt16BE(4);
    const v = Buffer.alloc(4);
    v.writeInt32BE(3);
    parts.push(
      Buffer.concat([Buffer.from([0x23]), nl, Buffer.from("printer-state"), vl, v]),
    );
  }
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}

// ── Local CUPS stub (exercises the real node:http transport) ─────────────────

interface StubReply {
  status?: number;
  statusMessage?: string;
  body?: Buffer | string;
}
type StubHandler = (ctx: { method: string; url: string; body: Buffer }) => StubReply;

const servers: http.Server[] = [];
let recorded: Array<{ method: string; url: string; body: Buffer }> = [];

async function startStub(handler: StubHandler): Promise<void> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      recorded.push({ method: req.method ?? "", url: req.url ?? "", body });
      const r = handler({ method: req.method ?? "", url: req.url ?? "", body });
      res.statusCode = r.status ?? 200;
      if (r.statusMessage) res.statusMessage = r.statusMessage;
      res.end(r.body ?? Buffer.alloc(0));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  process.env.CUPS_SERVER_URL = `http://127.0.0.1:${port}`;
}

let userId: number;
const ORIGINAL_CUPS = process.env.CUPS_SERVER_URL;

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
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.length = 0;
  recorded = [];
  if (ORIGINAL_CUPS === undefined) delete process.env.CUPS_SERVER_URL;
  else process.env.CUPS_SERVER_URL = ORIGINAL_CUPS;
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
    await startStub(() => ({ body: getPrintersResponse(["A", "B"]) }));
    const printers = await listPrinters();
    expect(printers.map((p) => p.name)).toEqual(["A", "B"]);
    expect(printers[0].state).toBe(3);
  });

  it("sends a clean POST without browser headers", async () => {
    let headers: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
      headers = req.headers;
      req.on("data", () => {});
      req.on("end", () => res.end(getPrintersResponse([])));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    process.env.CUPS_SERVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const port = (server.address() as AddressInfo).port;
    await listPrinters();
    expect(headers["content-type"]).toBe("application/ipp");
    expect(headers["content-length"]).toBeDefined();
    // Host is the resolved server IP (passes CUPS' rebinding check), not a name.
    expect(headers["host"]).toBe(`127.0.0.1:${port}`);
    // None of undici's browser headers must leak through.
    expect(headers["sec-fetch-mode"]).toBeUndefined();
    expect(headers["accept-language"]).toBeUndefined();
  });

  it("throws unavailable when the CUPS server is unreachable", async () => {
    process.env.CUPS_SERVER_URL = "http://127.0.0.1:1"; // nothing listening
    await expect(listPrinters()).rejects.toThrow(/nicht erreichbar/);
  });

  it("includes the HTTP status and response body on an error response", async () => {
    await startStub(() => ({ status: 400, statusMessage: "Bad Request", body: "Bad Request" }));
    await expect(listPrinters()).rejects.toThrow(/HTTP 400 Bad Request: Bad Request/);
  });
});

describe("label.service — getCupsBaseUrl", () => {
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
    await startStub(() => ({ body: getPrintersResponse(["A", "B"]) }));
    const res = await endpoints.listPrinters();
    expect(res.printers.map((p) => p.name)).toEqual(["A", "B"]);
    expect(res.selected).toBe("A");
    expect(res.cupsError).toBeNull();
  });

  it("listPrinters surfaces a CUPS error instead of throwing", async () => {
    process.env.CUPS_SERVER_URL = "http://127.0.0.1:1";
    const res = await endpoints.listPrinters();
    expect(res.printers).toEqual([]);
    expect(res.cupsError).toContain("nicht erreichbar");
  });

  it("savePrinter persists the selection", async () => {
    const res = await endpoints.savePrinter({ printer: "  DYMO  " });
    expect(res.selected).toBe("DYMO");
    expect(await getLabelPrefs(userId)).toEqual({ printer: "DYMO" });
  });

  it("persists templates and the last-used template", async () => {
    const template = {
      id: "storage-date",
      name: "Eingelagert",
      text: "Eingelagert am {{datum}}",
      labelCode: "99012",
      fontKey: "medium" as const,
      align: "left" as const,
      bold: true,
    };
    const saved = await endpoints.saveTemplates({
      templates: [template],
      lastTemplateId: template.id,
    });
    expect(saved).toEqual({ templates: [template], lastTemplateId: template.id });
    expect(await endpoints.listTemplates()).toEqual(saved);
  });

  it("keeps templates when the selected printer changes", async () => {
    const template = {
      id: "dated",
      name: "Datum",
      text: "{{datum}}",
      labelCode: "99010",
      fontKey: "small" as const,
      align: "center" as const,
      bold: false,
    };
    await endpoints.saveTemplates({ templates: [template], lastTemplateId: template.id });
    await endpoints.savePrinter({ printer: "DYMO" });
    expect(await getLabelPrefs(userId)).toEqual({
      printer: "DYMO",
      templates: [template],
      lastTemplateId: template.id,
    });
  });

  it("rejects an unknown last-used template", async () => {
    await expect(
      endpoints.saveTemplates({ templates: [], lastTemplateId: "missing" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("defaults bold to false when omitted", async () => {
    const template = {
      id: "no-bold",
      name: "Ohne Fett-Angabe",
      text: "Text",
      labelCode: "99012",
      fontKey: "medium" as const,
      align: "left" as const,
    } as unknown as svc.LabelTemplate;
    const saved = await endpoints.saveTemplates({ templates: [template], lastTemplateId: null });
    expect(saved.templates[0]?.bold).toBe(false);
  });

  it("rejects a non-boolean bold value", async () => {
    const template = {
      id: "bad-bold",
      name: "Ungültig",
      text: "Text",
      labelCode: "99012",
      fontKey: "medium" as const,
      align: "left" as const,
      bold: "yes",
    } as unknown as svc.LabelTemplate;
    await expect(
      endpoints.saveTemplates({ templates: [template], lastTemplateId: null }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("print rejects when no printer is selected", async () => {
    await expect(endpoints.print({ imageBase64: PNG_B64 })).rejects.toMatchObject({
      code: "failed_precondition",
    });
  });

  it("print rejects an empty image", async () => {
    await expect(
      endpoints.print({ imageBase64: "", printer: "A" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("print rejects a non-PNG image", async () => {
    const notPng = Buffer.from("not a png at all").toString("base64");
    await expect(
      endpoints.print({ imageBase64: notPng, printer: "A" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("print submits the image job to the printer path and remembers an explicit printer", async () => {
    await startStub(() => ({ body: ippHeader(0x0000) }));
    const res = await endpoints.print({ imageBase64: PNG_B64, copies: 2, printer: "A" });
    expect(res).toEqual({ printed: 2, printer: "A" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/printers/A");
    const sent = recorded[0].body.toString("latin1");
    expect(sent).toContain("image/png"); // document-format
    expect(sent).toContain("copies"); // copies > 1 → job attribute
    // The raw PNG bytes are appended as the document body.
    expect(recorded[0].body.includes(PNG_BYTES)).toBe(true);
    expect(await getLabelPrefs(userId)).toEqual({ printer: "A" });
  });

  it("print requires the label.print permission", async () => {
    setAuth(String(userId), ["label.view"]);
    await expect(
      endpoints.print({ imageBase64: PNG_B64, printer: "A" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});
