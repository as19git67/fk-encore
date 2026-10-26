/**
 * Unicode text in pdfkit. Its built-in Helvetica only knows WinAnsi (Western
 * European); anything else — a place name in Polish, Japanese or Chinese, an
 * arrow or emoji the model wrote — comes out as garbage ("日本" → "eåg,").
 * So PDFs with text from photos, places or the model embed a TrueType font
 * found on the machine: Noto Sans (the runtime image installs
 * `fonts-noto-core`), else DejaVu Sans; text in a CJK script switches to a
 * CJK font (`fonts-noto-cjk`, else WenQuanYi). Without any of them the text
 * falls back to Helvetica and is cleaned to what WinAnsi can show, so it
 * reads short of a letter rather than as garbage.
 */

import * as fs from "fs";

type FontSource = { path: string; family?: string };

const LATIN_REGULAR: FontSource[] = [
  { path: "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf" },
  { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf" },
];
const LATIN_BOLD: FontSource[] = [
  { path: "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf" },
  { path: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
];
const CJK_REGULAR: FontSource[] = [
  { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "NotoSansCJKjp-Regular" },
  { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", family: "WenQuanYiZenHei" },
];
const CJK_BOLD: FontSource[] = [
  { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", family: "NotoSansCJKjp-Bold" },
  ...CJK_REGULAR,
];

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Pictographs no text font draws; they would show as empty boxes. */
const PICTOGRAPHS = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** WinAnsi beyond Latin-1: the characters Helvetica can show in 0x80–0x9F. */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

function firstExisting(list: FontSource[]): FontSource | null {
  for (const f of list) {
    try {
      if (fs.statSync(f.path).isFile()) return f;
    } catch {
      // not installed here
    }
  }
  return null;
}

export interface PdfFonts {
  /** The font name for `text`, registered on the document. */
  font(text: string, bold?: boolean): string;
  /** `text` as the chosen font can show it. */
  clean(text: string): string;
}

/** Registers the fonts on `doc` and returns how to pick them per text. */
export function registerPdfFonts(doc: PDFKit.PDFDocument): PdfFonts {
  const register = (name: string, src: FontSource | null): string | null => {
    if (!src) return null;
    try {
      if (src.family) doc.registerFont(name, src.path, src.family);
      else doc.registerFont(name, src.path);
      return name;
    } catch {
      return null;
    }
  };
  const regular = register("text", firstExisting(LATIN_REGULAR));
  const bold = register("text-bold", firstExisting(LATIN_BOLD)) ?? regular;
  const cjk = register("text-cjk", firstExisting(CJK_REGULAR));
  const cjkBold = register("text-cjk-bold", firstExisting(CJK_BOLD)) ?? cjk;

  return {
    font(text, isBold = false) {
      if (CJK.test(text) && cjk) return (isBold ? cjkBold : cjk)!;
      if (isBold) return bold ?? "Helvetica-Bold";
      return regular ?? "Helvetica";
    },
    clean(text) {
      const t = text.replace(PICTOGRAPHS, "").replace(/\s+/g, " ").trim();
      if (regular) return t;
      return toWinAnsi(t);
    },
  };
}

/** What Helvetica can show: Latin-1 and the WinAnsi extras, accents dropped where it helps, the rest left out. */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      out += " ";
      continue;
    }
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
    if (base && [...base].every((b) => b.codePointAt(0)! < 0x80)) out += base;
    else if (ch === "ł") out += "l";
    else if (ch === "Ł") out += "L";
  }
  return out.replace(/ {2,}/g, " ").trim();
}

const registered = new WeakMap<PDFKit.PDFDocument, PdfFonts>();

/**
 * Sets the font for `text` on `doc` (registering the fonts on first use) and
 * returns the text as that font can show it:
 * `doc.fontSize(12).text(useFont(doc, title, true), x, y)`.
 */
export function useFont(doc: PDFKit.PDFDocument, text: string, bold = false): string {
  let fonts = registered.get(doc);
  if (!fonts) {
    fonts = registerPdfFonts(doc);
    registered.set(doc, fonts);
  }
  const clean = fonts.clean(text);
  doc.font(fonts.font(clean, bold));
  return clean;
}
