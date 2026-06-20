import { describe, it, expect } from "vitest";
import {
  buildGetPrintersRequest,
  buildPrintJobRequest,
  parseIppResponse,
  parsePrinters,
  OP_PRINT_JOB,
  OP_CUPS_GET_PRINTERS,
  TAG_PRINTER_ATTRIBUTES,
} from "./ipp";

// ── Test fixture builder ────────────────────────────────────────────────────
// Hand-rolls IPP attribute bytes so the parser is validated against an
// independent encoder (not its own writer).

function strAttr(tag: number, name: string, value: string): Buffer {
  const n = Buffer.from(name, "utf8");
  const v = Buffer.from(value, "utf8");
  const nl = Buffer.alloc(2);
  nl.writeUInt16BE(n.length);
  const vl = Buffer.alloc(2);
  vl.writeUInt16BE(v.length);
  return Buffer.concat([Buffer.from([tag]), nl, n, vl, v]);
}

function intAttr(tag: number, name: string, value: number): Buffer {
  const n = Buffer.from(name, "utf8");
  const nl = Buffer.alloc(2);
  nl.writeUInt16BE(n.length);
  const vl = Buffer.alloc(2);
  vl.writeUInt16BE(4);
  const v = Buffer.alloc(4);
  v.writeInt32BE(value);
  return Buffer.concat([Buffer.from([tag]), nl, n, vl, v]);
}

const VTAG_ENUM = 0x23;
const VTAG_TEXT = 0x41;
const VTAG_NAME = 0x42;
const VTAG_CHARSET = 0x47;
const VTAG_NATURAL_LANGUAGE = 0x48;

function buildGetPrintersResponse(
  printers: Array<{ name: string; state: number; info?: string }>,
): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt8(2, 0); // version major
  head.writeUInt8(0, 1); // version minor
  head.writeUInt16BE(0x0000, 2); // status: successful-ok
  head.writeUInt32BE(1, 4); // request id

  const parts: Buffer[] = [head];

  // operation-attributes group (tag 0x01)
  parts.push(Buffer.from([0x01]));
  parts.push(strAttr(VTAG_CHARSET, "attributes-charset", "utf-8"));
  parts.push(strAttr(VTAG_NATURAL_LANGUAGE, "attributes-natural-language", "en"));

  for (const p of printers) {
    parts.push(Buffer.from([TAG_PRINTER_ATTRIBUTES]));
    parts.push(strAttr(VTAG_NAME, "printer-name", p.name));
    parts.push(intAttr(VTAG_ENUM, "printer-state", p.state));
    if (p.info) parts.push(strAttr(VTAG_TEXT, "printer-info", p.info));
  }

  parts.push(Buffer.from([0x03])); // end-of-attributes
  return Buffer.concat(parts);
}

describe("ipp — request encoding", () => {
  it("encodes a CUPS-Get-Printers header", () => {
    const buf = buildGetPrintersRequest(7);
    expect(buf.readUInt8(0)).toBe(2); // version major
    expect(buf.readUInt8(1)).toBe(0); // version minor
    expect(buf.readUInt16BE(2)).toBe(OP_CUPS_GET_PRINTERS);
    expect(buf.readUInt32BE(4)).toBe(7);
    // ends with the end-of-attributes delimiter
    expect(buf.readUInt8(buf.length - 1)).toBe(0x03);
  });

  it("encodes a Print-Job with the document appended after the attributes", () => {
    const text = "Hallo Welt";
    const buf = buildPrintJobRequest({
      printerUri: "ipp://pi.local:631/printers/DYMO",
      user: "tester",
      jobName: "job",
      text,
      copies: 1,
    });
    expect(buf.readUInt16BE(2)).toBe(OP_PRINT_JOB);
    // The raw document is appended verbatim at the very end.
    expect(buf.subarray(buf.length - Buffer.byteLength(text)).toString("utf8")).toBe(
      text,
    );
    // Operation attributes (printer-uri, document-format) are present.
    const asString = buf.toString("latin1");
    expect(asString).toContain("printer-uri");
    expect(asString).toContain("document-format");
    expect(asString).toContain("text/plain");
  });

  it("emits a copies job attribute only when copies > 1", () => {
    const one = buildPrintJobRequest({
      printerUri: "ipp://h/printers/p",
      user: "u",
      jobName: "j",
      text: "x",
      copies: 1,
    });
    expect(one.toString("latin1")).not.toContain("copies");

    const many = buildPrintJobRequest({
      printerUri: "ipp://h/printers/p",
      user: "u",
      jobName: "j",
      text: "x",
      copies: 3,
    });
    expect(many.toString("latin1")).toContain("copies");
  });

  it("emits a page-left job attribute only when leftMarginPt > 0", () => {
    const base = { printerUri: "ipp://h/printers/p", user: "u", jobName: "j", text: "x" };
    expect(buildPrintJobRequest({ ...base }).toString("latin1")).not.toContain(
      "page-left",
    );
    expect(
      buildPrintJobRequest({ ...base, leftMarginPt: 1 }).toString("latin1"),
    ).toContain("page-left");
  });
});

describe("ipp — response parsing", () => {
  it("parses status and request id", () => {
    const buf = buildGetPrintersResponse([{ name: "A", state: 3 }]);
    const resp = parseIppResponse(buf);
    expect(resp.statusCode).toBe(0x0000);
    expect(resp.requestId).toBe(1);
  });

  it("extracts multiple printers with their attributes", () => {
    const buf = buildGetPrintersResponse([
      { name: "DYMO_LabelWriter_450", state: 3, info: "DYMO LabelWriter 450" },
      { name: "Office_Laser", state: 5 },
    ]);
    const printers = parsePrinters(parseIppResponse(buf));
    expect(printers).toHaveLength(2);
    expect(printers[0]).toMatchObject({
      name: "DYMO_LabelWriter_450",
      state: 3,
      info: "DYMO LabelWriter 450",
    });
    expect(printers[1]).toMatchObject({ name: "Office_Laser", state: 5, info: null });
  });

  it("returns no printers when the response has none", () => {
    const buf = buildGetPrintersResponse([]);
    expect(parsePrinters(parseIppResponse(buf))).toEqual([]);
  });
});
