import { describe, it, expect } from "vitest";
import * as fs from "fs";
import PDFDocument from "pdfkit";
import { toWinAnsi, useFont } from "./pdf-fonts";

describe("pdf fonts", () => {
  it("cleans text to what Helvetica can show when no font is installed", () => {
    expect(toWinAnsi("Äpfel „am Turm“ – 5 €")).toBe("Äpfel „am Turm“ – 5 €");
    expect(toWinAnsi("Kraków Łódź ő")).toBe("Kraków Lódz o");
    expect(toWinAnsi("日本 Musterstadt → Turm")).toBe("Musterstadt Turm");
  });

  it("embeds a Unicode font where one is installed, and a CJK one for CJK text", () => {
    const doc = new PDFDocument({ autoFirstPage: false });
    expect(useFont(doc, "Blick über Musterstadt 😀")).toBe("Blick über Musterstadt");
    const name = (doc as unknown as { _font: { name: string } })._font.name;
    if (fs.existsSync("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf") || fs.existsSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")) {
      expect(name).not.toMatch(/^Helvetica/);
    }
    useFont(doc, "東京タワー", true);
    const cjk = (doc as unknown as { _font: { name: string } })._font.name;
    if (fs.existsSync("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc") || fs.existsSync("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc")) {
      expect(cjk).not.toBe(name);
    }
  });
});
