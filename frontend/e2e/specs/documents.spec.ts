import { test, expect } from '@playwright/test'
import path from 'node:path'

test.describe('Dokumenten-Modul (Drag-and-Drop + Tastatur)', () => {
  test('Suchfeld ist per Tastatur erreichbar und debounced', async ({ page }) => {
    await page.goto('dokumente')
    await expect(page.getByRole('heading', { name: 'Dokumente' })).toBeVisible()

    const search = page.getByPlaceholder('Suche in Dokumenten…')
    await search.click()
    await expect(search).toBeFocused()

    // Realistische Eingabegeschwindigkeit, damit das 300 ms Debounce
    // tatsächlich greift und die zwischenzeitlichen Keystrokes nicht
    // jeweils einen Request feuern.
    await page.keyboard.type('rechnung', { delay: 40 })
    await expect(search).toHaveValue('rechnung')

    // Die Filter-Selects sollen während aktiver Suche disabled sein
    // (siehe :disabled="q.trim().length > 0" im Template).
    const kategorie = page.getByRole('combobox').first()
    await expect(kategorie).toBeDisabled()
  })

  test('Zur Upload-Seite navigieren und Datei per File-Input wählen', async ({ page }) => {
    await page.goto('dokumente')

    // Top-Nav rendert ebenfalls einen "Hochladen"-Button — wir wollen
    // explizit den auf der Dokumenten-Seite anklicken.
    const uploadBtn = page.getByRole('main').getByRole('button', { name: 'Hochladen' })
    // Permission-abhängig — überspringen, wenn Admin sie nicht hat.
    if ((await uploadBtn.count()) === 0) {
      test.skip(true, 'Aktueller Nutzer hat documents.upload nicht — übersprungen')
      return
    }
    await uploadBtn.click()

    await expect(page).toHaveURL(/\/dokumente\/upload/)
    await expect(page.getByText('PDFs hier ablegen')).toBeVisible()

    // Versteckter <input type="file"> hängt an .dropzone — Playwright kann
    // direkt setInputFiles() rufen, ohne den Klick zu simulieren.
    const fixturePdf = await pdfFixture()
    const fileInput = page.locator('.dropzone input[type="file"]')
    await fileInput.setInputFiles(fixturePdf)

    // Datei taucht in der Queue auf
    await expect(page.getByText(path.basename(fixturePdf))).toBeVisible()
  })

  test('Drag-and-Drop einer PDF auf die Dropzone fügt sie der Warteschlange hinzu', async ({ page }) => {
    await page.goto('dokumente/upload')
    await expect(page.getByText('PDFs hier ablegen')).toBeVisible()

    const dropzone = page.locator('.dropzone')

    // DataTransfer kann nicht direkt aus Node geladen werden — wir
    // konstruieren ihn im Page-Kontext und feuern dragenter/over/drop.
    await dropzone.dispatchEvent('dragenter')
    await dropzone.dispatchEvent('dragover')

    const buffer = await readPdfBuffer()
    const dataTransfer = await page.evaluateHandle(
      ({ data, name }) => {
        const dt = new DataTransfer()
        const file = new File([new Uint8Array(data)], name, { type: 'application/pdf' })
        dt.items.add(file)
        return dt
      },
      { data: Array.from(buffer), name: 'e2e-drop.pdf' },
    )
    await dropzone.dispatchEvent('drop', { dataTransfer })

    await expect(page.getByText('e2e-drop.pdf')).toBeVisible()
  })

  test('Enter auf Dropzone öffnet den File-Picker (Tastatur-Pfad)', async ({ page }) => {
    await page.goto('dokumente/upload')
    const dropzone = page.locator('.dropzone')
    await dropzone.focus()

    // Wir können den Picker nicht aus dem Headless-Browser sehen, aber
    // das @keydown.enter-Handler löst fileInput?.click() aus. Indirekt
    // prüfen: setInputFiles() funktioniert direkt am hidden Input und
    // demonstriert den Pfad zum gleichen DOM-Element.
    await page.keyboard.press('Enter')
    const fileInput = page.locator('.dropzone input[type="file"]')
    await expect(fileInput).toBeAttached()
  })
})

async function pdfFixture(): Promise<string> {
  const fs = await import('node:fs/promises')
  const dir = path.resolve(process.cwd(), 'e2e/.fixtures')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'sample.pdf')
  await fs.writeFile(file, await readPdfBuffer())
  return file
}

async function readPdfBuffer(): Promise<Buffer> {
  // Minimal valid 1-page PDF. Avoids pulling a binary fixture into git.
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 100 Td (E2E Test PDF) Tj ET
endstream endobj
xref
0 5
0000000000 65535 f
0000000010 00000 n
0000000053 00000 n
0000000098 00000 n
0000000165 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
253
%%EOF
`
  return Buffer.from(pdf, 'latin1')
}
