/**
 * Builds a valid multi-page PDF as a byte string, for stories that need to
 * exercise the continuous page view (#919). Each page carries its own number
 * so scrolling through the stack is visually verifiable.
 *
 * Kept deliberately hand-rolled: the frontend has no PDF *writer* dependency,
 * and a fixture file would be binary noise in the repo.
 */
export function buildMultiPagePdf(pageCount: number): string {
  const width = 595 // A4 @ 72 dpi
  const height = 842

  // Object 1: catalog, 2: page tree, 3: font. Then two objects per page
  // (page dict + content stream).
  const objects: string[] = []
  const pageObjNumber = (i: number) => 4 + i * 2
  const contentObjNumber = (i: number) => 5 + i * 2

  const kids = Array.from({ length: pageCount }, (_, i) => `${pageObjNumber(i)} 0 R`).join(' ')

  objects.push('<</Type/Catalog/Pages 2 0 R>>')
  objects.push(`<</Type/Pages/Count ${pageCount}/Kids[${kids}]>>`)
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>')

  for (let i = 0; i < pageCount; i++) {
    const text = `BT /F1 48 Tf 72 ${height - 140} Td (Seite ${i + 1} von ${pageCount}) Tj ET`
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]` +
        `/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentObjNumber(i)} 0 R>>`,
    )
    objects.push(`<</Length ${text.length}>>\nstream\n${text}\nendstream`)
  }

  // Assemble the file while recording each object's byte offset for the
  // cross-reference table.
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return pdf
}
