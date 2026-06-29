/**
 * Hand-crafted single-page PDF wrapper for receipt images.
 *
 * Receipt captures are stored as a one-page PDF with the photo embedded as a
 * JPEG (via the `/DCTDecode` filter). Keeping this in its own module lets both
 * the upload path (`documents.ts`) and the OCR worker (`document-ops.ts`, which
 * replaces the stored file with the service-corrected image) share the exact
 * same wrapper without an import cycle.
 */

import sharp from "sharp";

/** Wrap a JPEG buffer into a single-page A4 PDF, sizing the page box from the
 *  image's own pixel dimensions. */
export async function jpegToReceiptPdf(jpeg: Buffer): Promise<Buffer> {
  const meta = await sharp(jpeg, { failOn: "none" }).metadata();
  return singleJpegPagePdf(jpeg, meta.width || 1000, meta.height || 1000);
}

export function singleJpegPagePdf(jpeg: Buffer, imageWidth: number, imageHeight: number): Buffer {
  const pageWidth = 595.28; // A4 portrait in PDF points
  const pageHeight = 841.89;
  const margin = 24;
  const scale = Math.min((pageWidth - margin * 2) / imageWidth, (pageHeight - margin * 2) / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const x = (pageWidth - drawWidth) / 2;
  const y = (pageHeight - drawHeight) / 2;
  const content = Buffer.from(
    `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`,
    "ascii",
  );
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    {
      dict: `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
      stream: jpeg,
    },
    { dict: `<< /Length ${content.length} >>`, stream: content },
  ]);
}

function buildPdf(objects: Array<string | { dict: string; stream: Buffer }>): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets: number[] = [];
  let offset = chunks[0].length;
  objects.forEach((obj, index) => {
    offsets.push(offset);
    const prefix = Buffer.from(`${index + 1} 0 obj\n`, "ascii");
    const body = typeof obj === "string"
      ? Buffer.from(`${obj}\n`, "ascii")
      : Buffer.concat([
          Buffer.from(`${obj.dict}\nstream\n`, "ascii"),
          obj.stream,
          Buffer.from("\nendstream\n", "ascii"),
        ]);
    const suffix = Buffer.from("endobj\n", "ascii");
    chunks.push(prefix, body, suffix);
    offset += prefix.length + body.length + suffix.length;
  });
  const xrefOffset = offset;
  const xrefLines = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ];
  chunks.push(Buffer.from(xrefLines.join("\n"), "ascii"));
  return Buffer.concat(chunks);
}
