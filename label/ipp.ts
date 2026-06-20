/**
 * Minimal IPP (Internet Printing Protocol, RFC 8010/8011) client codec.
 *
 * Just enough of the binary protocol to talk to a CUPS server over HTTP:
 *   - CUPS-Get-Printers  → enumerate the queues a CUPS server exposes.
 *   - Print-Job          → submit a text/plain document to a queue.
 *
 * Kept dependency-free (no `ipp` npm package) and free of any Encore /
 * database imports so it can be unit-tested in isolation. The transport
 * (fetch to the CUPS server) lives in label.service.ts.
 */

// ---------- Tags ----------

// Delimiter tags (start an attribute group). Values 0x00–0x05.
const TAG_OPERATION_ATTRIBUTES = 0x01;
const TAG_JOB_ATTRIBUTES = 0x02;
const TAG_END_OF_ATTRIBUTES = 0x03;
export const TAG_PRINTER_ATTRIBUTES = 0x04;

// Value tags.
const VTAG_INTEGER = 0x21;
const VTAG_BOOLEAN = 0x22;
const VTAG_ENUM = 0x23;
const VTAG_TEXT = 0x41; // textWithoutLanguage
const VTAG_NAME = 0x42; // nameWithoutLanguage
const VTAG_KEYWORD = 0x44;
const VTAG_URI = 0x45;
const VTAG_CHARSET = 0x47;
const VTAG_NATURAL_LANGUAGE = 0x48;
const VTAG_MIME_MEDIA_TYPE = 0x49;

// Operation ids.
export const OP_PRINT_JOB = 0x0002;
export const OP_CUPS_GET_PRINTERS = 0x4002;

// IPP status codes 0x0000–0x00ff are "successful". Anything ≥ 0x0100 is an
// error/warning the caller should treat as a failure.
export const IPP_STATUS_OK_MAX = 0x00ff;

// ---------- Encoder ----------

class IppWriter {
  private chunks: Buffer[] = [];

  private u8(n: number): void {
    this.chunks.push(Buffer.from([n & 0xff]));
  }
  private u16(n: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n & 0xffff);
    this.chunks.push(b);
  }
  private u32(n: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    this.chunks.push(b);
  }

  delimiter(tag: number): this {
    this.u8(tag);
    return this;
  }

  /** A named string-valued attribute (name, text, keyword, uri, charset…). */
  strAttr(valueTag: number, name: string, value: string): this {
    this.u8(valueTag);
    const nameBuf = Buffer.from(name, "utf8");
    this.u16(nameBuf.length);
    this.chunks.push(nameBuf);
    const valBuf = Buffer.from(value, "utf8");
    this.u16(valBuf.length);
    this.chunks.push(valBuf);
    return this;
  }

  /** An additional value of the preceding attribute (1setOf): zero-length name. */
  addlStrValue(valueTag: number, value: string): this {
    this.u8(valueTag);
    this.u16(0);
    const valBuf = Buffer.from(value, "utf8");
    this.u16(valBuf.length);
    this.chunks.push(valBuf);
    return this;
  }

  /** A named 32-bit integer attribute. */
  intAttr(valueTag: number, name: string, value: number): this {
    this.u8(valueTag);
    const nameBuf = Buffer.from(name, "utf8");
    this.u16(nameBuf.length);
    this.chunks.push(nameBuf);
    this.u16(4);
    const valBuf = Buffer.alloc(4);
    valBuf.writeInt32BE(value);
    this.chunks.push(valBuf);
    return this;
  }

  header(operationId: number, requestId: number): this {
    this.u8(2); // version major
    this.u8(0); // version minor → 2.0
    this.u16(operationId);
    this.u32(requestId);
    return this;
  }

  raw(buf: Buffer): this {
    this.chunks.push(buf);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// ---------- Requests ----------

/**
 * CUPS-Get-Printers request. Sent (HTTP POST) to the CUPS server root path
 * `/`. Limits the response to the attributes we render in the UI.
 */
export function buildGetPrintersRequest(requestId = 1): Buffer {
  const w = new IppWriter();
  w.header(OP_CUPS_GET_PRINTERS, requestId);
  w.delimiter(TAG_OPERATION_ATTRIBUTES);
  w.strAttr(VTAG_CHARSET, "attributes-charset", "utf-8");
  w.strAttr(VTAG_NATURAL_LANGUAGE, "attributes-natural-language", "en");
  w.strAttr(VTAG_KEYWORD, "requested-attributes", "printer-name");
  w.addlStrValue(VTAG_KEYWORD, "printer-info");
  w.addlStrValue(VTAG_KEYWORD, "printer-location");
  w.addlStrValue(VTAG_KEYWORD, "printer-state");
  w.addlStrValue(VTAG_KEYWORD, "printer-make-and-model");
  w.delimiter(TAG_END_OF_ATTRIBUTES);
  return w.build();
}

export interface PrintJobOptions {
  /** Full IPP printer URI, e.g. ipp://host:631/printers/DYMO. */
  printerUri: string;
  /** requesting-user-name reported to CUPS. */
  user: string;
  /** Human-readable job name shown in the CUPS queue. */
  jobName: string;
  /** Document body (printed as text/plain — CUPS rasterizes via the driver). */
  text: string;
  /** Number of copies (≥ 1). Emitted as the IPP `copies` job attribute. */
  copies?: number;
  /**
   * Left print margin in points (1 pt = 1/72"). Emitted as the CUPS
   * `page-left` option so the text isn't flush against the label edge.
   * Omitted/0 → no margin attribute.
   */
  leftMarginPt?: number;
  /**
   * Characters per inch (CUPS `cpi` text option). Lower = larger font.
   * Omitted/0 → CUPS default (10).
   */
  cpi?: number;
  /**
   * Lines per inch (CUPS `lpi` text option). Lower = taller lines / fewer
   * lines per label. Omitted/0 → CUPS default (6).
   */
  lpi?: number;
  requestId?: number;
}

/**
 * Print-Job request. Sent (HTTP POST) to the printer path
 * `/printers/<name>`. The document is appended raw after the
 * end-of-attributes delimiter.
 */
export function buildPrintJobRequest(opts: PrintJobOptions): Buffer {
  const w = new IppWriter();
  w.header(OP_PRINT_JOB, opts.requestId ?? 1);
  w.delimiter(TAG_OPERATION_ATTRIBUTES);
  w.strAttr(VTAG_CHARSET, "attributes-charset", "utf-8");
  w.strAttr(VTAG_NATURAL_LANGUAGE, "attributes-natural-language", "en");
  w.strAttr(VTAG_URI, "printer-uri", opts.printerUri);
  w.strAttr(VTAG_NAME, "requesting-user-name", opts.user);
  w.strAttr(VTAG_NAME, "job-name", opts.jobName);
  w.strAttr(VTAG_MIME_MEDIA_TYPE, "document-format", "text/plain");

  const copies = opts.copies ?? 1;
  const leftMargin = opts.leftMarginPt ?? 0;
  const cpi = opts.cpi ?? 0;
  const lpi = opts.lpi ?? 0;
  if (copies > 1 || leftMargin > 0 || cpi > 0 || lpi > 0) {
    w.delimiter(TAG_JOB_ATTRIBUTES);
    if (copies > 1) w.intAttr(VTAG_INTEGER, "copies", copies);
    if (leftMargin > 0) w.intAttr(VTAG_INTEGER, "page-left", leftMargin);
    if (cpi > 0) w.intAttr(VTAG_INTEGER, "cpi", cpi);
    if (lpi > 0) w.intAttr(VTAG_INTEGER, "lpi", lpi);
  }

  w.delimiter(TAG_END_OF_ATTRIBUTES);
  w.raw(Buffer.from(opts.text, "utf8"));
  return w.build();
}

// ---------- Response parsing ----------

export type IppValue = string | number | boolean;

export interface IppAttribute {
  tag: number;
  name: string;
  values: IppValue[];
}

export interface IppGroup {
  tag: number;
  attributes: IppAttribute[];
}

export interface IppResponse {
  statusCode: number;
  requestId: number;
  groups: IppGroup[];
}

function decodeValue(tag: number, b: Buffer): IppValue {
  switch (tag) {
    case VTAG_INTEGER:
    case VTAG_ENUM:
      return b.length >= 4 ? b.readInt32BE(0) : 0;
    case VTAG_BOOLEAN:
      return b.length >= 1 ? b.readUInt8(0) === 1 : false;
    default:
      return b.toString("utf8");
  }
}

/**
 * Parse an IPP response message into status, request id and attribute
 * groups. Trailing document data (if any) after end-of-attributes is
 * ignored. Tolerant of truncation: stops cleanly at the buffer end.
 */
export function parseIppResponse(buf: Buffer): IppResponse {
  let off = 0;
  // version (2) + status-code (2) + request-id (4)
  off += 2;
  const statusCode = buf.readUInt16BE(off);
  off += 2;
  const requestId = buf.readUInt32BE(off);
  off += 4;

  const groups: IppGroup[] = [];
  let current: IppGroup | null = null;
  let lastAttr: IppAttribute | null = null;

  while (off < buf.length) {
    const tag = buf.readUInt8(off);
    off += 1;

    if (tag <= 0x05) {
      // Delimiter tag — starts a new group (or ends the message).
      if (tag === TAG_END_OF_ATTRIBUTES) break;
      current = { tag, attributes: [] };
      groups.push(current);
      lastAttr = null;
      continue;
    }

    // Value tag → an attribute (or an additional value of the previous one).
    if (off + 2 > buf.length) break;
    const nameLen = buf.readUInt16BE(off);
    off += 2;
    const name = nameLen > 0 ? buf.toString("utf8", off, off + nameLen) : "";
    off += nameLen;
    if (off + 2 > buf.length) break;
    const valueLen = buf.readUInt16BE(off);
    off += 2;
    const valueBytes = buf.subarray(off, off + valueLen);
    off += valueLen;

    const value = decodeValue(tag, valueBytes);
    if (nameLen === 0 && lastAttr) {
      lastAttr.values.push(value);
    } else {
      const attr: IppAttribute = { tag, name, values: [value] };
      current?.attributes.push(attr);
      lastAttr = attr;
    }
  }

  return { statusCode, requestId, groups };
}

// ---------- Printer extraction ----------

export interface CupsPrinter {
  name: string;
  info: string | null;
  location: string | null;
  /** IPP printer-state enum: 3 = idle, 4 = processing, 5 = stopped. */
  state: number | null;
  makeAndModel: string | null;
}

function firstString(attr: IppAttribute | undefined): string | null {
  const v = attr?.values[0];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function firstNumber(attr: IppAttribute | undefined): number | null {
  const v = attr?.values[0];
  return typeof v === "number" ? v : null;
}

/**
 * Extract the printer list from a parsed CUPS-Get-Printers response.
 * Each printer arrives in its own printer-attributes group.
 */
export function parsePrinters(resp: IppResponse): CupsPrinter[] {
  const printers: CupsPrinter[] = [];
  for (const group of resp.groups) {
    if (group.tag !== TAG_PRINTER_ATTRIBUTES) continue;
    const byName = (n: string) => group.attributes.find((a) => a.name === n);
    const name = firstString(byName("printer-name"));
    if (!name) continue;
    printers.push({
      name,
      info: firstString(byName("printer-info")),
      location: firstString(byName("printer-location")),
      state: firstNumber(byName("printer-state")),
      makeAndModel: firstString(byName("printer-make-and-model")),
    });
  }
  return printers;
}
