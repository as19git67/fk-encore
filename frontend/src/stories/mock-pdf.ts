/**
 * A real, multi-page PDF for the Storybook mocks.
 *
 * The previous stand-in was a valid file with `/Count 0` and no pages, which
 * kept the network happy and rendered nothing — so every story that shows the
 * viewer showed an empty box, and a layout bug in the viewer's own scroll
 * container could not appear in a screenshot at all. Pages tall enough to
 * overflow any pane are exactly what makes such a bug visible.
 *
 * Hand-assembled rather than generated: a dependency-free string keeps the
 * mock readable, and the only tricky part — byte offsets in the xref table —
 * is computed here rather than typed.
 */

/** Build a valid PDF of `pageCount` A4 pages, each labelled with its number. */
export function makeMultiPagePdf(pageCount = 6): Uint8Array {
  const pageWidth = 595
  const pageHeight = 842

  // Object 1 is the catalog, 2 the page tree, then two objects per page
  // (the page and its content stream).
  const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i * 2)
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ]

  for (let page = 1; page <= pageCount; page++) {
    const contentId = 3 + (page - 1) * 2 + 1
    const content =
      `BT /F1 36 Tf 72 ${pageHeight - 120} Td (Seite ${page} von ${pageCount}) Tj ET\n` +
      `1 0 0 RG 4 w 40 40 ${pageWidth - 80} ${pageHeight - 80} re S\n`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ` +
        `/Contents ${contentId} 0 R >>`,
    )
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  }

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${obj}\nendobj\n`
  })

  const xrefOffset = body.length
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n')

  return new TextEncoder().encode(body + xref)
}
