import { test, expect, type Page } from '@playwright/test'
import { adminApi } from '../../fixtures/api'
import { addReading, createMeter, daysAgo, saveQuickEntry, uniqueName } from '../../fixtures/meters'
import { pageTitle, typeNumber } from '../../fixtures/ui'

// Zähler › Schnellerfassung (`SCH`) und ihre Konfiguration (`SKO`),
// documentation/handbuch/zaehler.md. The configuration belongs to the user,
// so these tests share it and run one after the other.

test.describe.configure({ mode: 'serial' })

function entryRow(page: Page, name: string) {
  return page.locator('.entry-row').filter({ hasText: name })
}

function configRows(page: Page) {
  return page.locator('.config-list li')
}

async function openQuickEntry(page: Page) {
  await page.goto('zaehler/schnellerfassung')
  await expect(pageTitle(page, 'Schnellerfassung')).toBeVisible()
}

async function openConfig(page: Page) {
  await page.goto('zaehler/schnellerfassung/konfiguration')
  await expect(pageTitle(page, 'Schnellerfassung konfigurieren')).toBeVisible()
}

function ddmmyyyy(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

async function readingsOf(meterId: number) {
  const { ctx } = await adminApi()
  const res = await ctx.get(`/meters/${meterId}/readings`)
  return ((await res.json()) as { readings: Array<{ value: number; takenAt: string; notes: string | null; source: string }> }).readings
}

test.describe('Zähler › Schnellerfassung', () => {
  test('ZAE-SKO-05 Leere Konfiguration', async ({ page }) => {
    await saveQuickEntry([])
    await openConfig(page)
    await expect(page.getByText('Noch keine Zähler ausgewählt. Füge oben die Zähler hinzu, die du regelmäßig abliest.')).toBeVisible()
    await expect(page.locator('.section-title')).toContainText('0 Zähler')
  })

  test('ZAE-SCH-01 Konfiguration öffnen', async ({ page }) => {
    await saveQuickEntry([])
    await openQuickEntry(page)

    // With nothing configured the hint leads to the configuration …
    await expect(page.getByText('Konfiguriere zuerst mindestens einen Zähler.')).toBeVisible()
    await page.getByRole('button', { name: 'Konfiguration öffnen' }).click()
    await expect(pageTitle(page, 'Schnellerfassung konfigurieren')).toBeVisible()

    // … and the cog in the header always does.
    await openQuickEntry(page)
    await page.locator('.page-actions button:has(.pi-cog)').click()
    await expect(page).toHaveURL(/\/zaehler\/schnellerfassung\/konfiguration$/)
  })

  test('ZAE-SKO-01 Zurück zur Erfassung', async ({ page }) => {
    await openConfig(page)
    await page.getByRole('button', { name: 'Zurück zur Erfassung' }).click()
    await expect(page).toHaveURL(/\/zaehler\/schnellerfassung$/)
  })

  test('ZAE-SKO-02 Zähler hinzufügen', async ({ page }) => {
    await saveQuickEntry([])
    const meter = await createMeter({ name: uniqueName('E2E Schnell hinzufügen') })
    await openConfig(page)

    await expect(page.getByRole('button', { name: 'Hinzufügen' })).toBeDisabled()
    await page.locator('.add-select').click()
    await page.getByRole('option', { name: `${meter.name} · Strom` }).click()
    await page.getByRole('button', { name: 'Hinzufügen' }).click()

    await expect(configRows(page)).toHaveCount(1)
    await expect(configRows(page).first()).toContainText(meter.name)
    await expect(page.locator('.section-title')).toContainText('1 Zähler')
    await expect(page.locator('.p-message-success')).toContainText('Konfiguration gespeichert.')

    // Saved at once: a reload shows the same list, and the meter is no longer offered.
    await page.reload()
    await expect(configRows(page)).toHaveCount(1)
    await page.locator('.add-select').click()
    await expect(page.getByRole('option', { name: `${meter.name} · Strom` })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('ZAE-SKO-03 Reihenfolge ändern', async ({ page }) => {
    const first = await createMeter({ name: uniqueName('E2E Schnell erster') })
    const second = await createMeter({ name: uniqueName('E2E Schnell zweiter') })
    await saveQuickEntry([first.id, second.id])
    await openConfig(page)

    await expect(configRows(page).first().getByRole('button', { name: 'Zähler nach oben' })).toBeDisabled()
    await expect(configRows(page).last().getByRole('button', { name: 'Zähler nach unten' })).toBeDisabled()

    await configRows(page).first().getByRole('button', { name: 'Zähler nach unten' }).click()
    await expect(configRows(page).first()).toContainText(second.name)
    await expect(configRows(page).last()).toContainText(first.name)

    await openQuickEntry(page)
    await expect(page.locator('.entry-row').first()).toContainText(second.name)
    await expect(page.locator('.entry-row').last()).toContainText(first.name)
  })

  test('ZAE-SKO-04 Zähler aus der Liste nehmen', async ({ page }) => {
    const keep = await createMeter({ name: uniqueName('E2E Schnell bleibt') })
    const drop = await createMeter({ name: uniqueName('E2E Schnell raus') })
    await saveQuickEntry([keep.id, drop.id])
    await openConfig(page)

    await configRows(page)
      .filter({ hasText: drop.name })
      .getByRole('button', { name: 'Zähler aus der Schnellerfassung nehmen' })
      .click()
    await expect(configRows(page)).toHaveCount(1)
    await expect(configRows(page).first()).toContainText(keep.name)

    // Offered again in the picker; the meter itself is untouched.
    await page.locator('.add-select').click()
    await expect(page.getByRole('option', { name: `${drop.name} · Strom` })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('ZAE-SCH-02 Datum für alle Werte setzen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Schnell Datum') })
    await addReading(meter.id, 10, daysAgo(10))
    await saveQuickEntry([meter.id])
    await openQuickEntry(page)

    const date = page.locator('.date-field input')
    await expect(date).toHaveValue(ddmmyyyy(new Date()))

    const chosen = daysAgo(3)
    await date.fill(ddmmyyyy(chosen))
    await date.blur()
    await page.keyboard.press('Escape')

    await typeNumber(entryRow(page, meter.name).locator('input'), 20)
    await entryRow(page, meter.name).getByRole('button', { name: 'Speichern' }).click()
    await expect(entryRow(page, meter.name).getByRole('button', { name: 'Gespeichert' })).toBeVisible()

    const saved = (await readingsOf(meter.id)).find((r) => r.value === 20)
    expect(saved).toBeTruthy()
    expect(ddmmyyyy(new Date(saved!.takenAt))).toBe(ddmmyyyy(chosen))
  })

  test('ZAE-SCH-03 Einen Wert erfassen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Schnell ein Wert') })
    await addReading(meter.id, 100, daysAgo(30))
    await saveQuickEntry([meter.id])
    await openQuickEntry(page)

    const row = entryRow(page, meter.name)
    await expect(row).toContainText('Vorher: 100 kWh')

    // Empty field.
    await row.getByRole('button', { name: 'Speichern' }).click()
    await expect(row.locator('.p-message-warn')).toContainText('Bitte einen Zählerstand eingeben.')

    // Below the last reading: refused by the server.
    await typeNumber(row.locator('input'), 50)
    await row.getByRole('button', { name: 'Speichern' }).click()
    await expect(row.locator('.p-message-warn')).toContainText('must be >= the previous reading')

    await typeNumber(row.locator('input'), 110)
    await row.getByRole('button', { name: 'Speichern' }).click()
    await expect(row.getByRole('button', { name: 'Gespeichert' })).toBeVisible()
    await expect(row.locator('.row-info')).toHaveText('Gespeichert')
    expect((await readingsOf(meter.id)).map((r) => r.value)).toContain(110)

    // Changing the value again turns the button back to "Speichern".
    await typeNumber(row.locator('input'), 111)
    await expect(row.getByRole('button', { name: 'Speichern' })).toBeVisible()
  })

  test('ZAE-SCH-04 Wert per Foto erkennen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Schnell OCR') })
    await saveQuickEntry([meter.id])
    // Fixed answer instead of the OCR service.
    await page.route('**/meters/*/readings/ocr', (route) =>
      route.fulfill({ json: { value: 2468, confidence: 0.87, photoPath: '', rawText: '2468' } }),
    )
    await openQuickEntry(page)

    const row = entryRow(page, meter.name)
    const chooser = page.waitForEvent('filechooser')
    await row.locator('button:has(.pi-camera)').click()
    await (await chooser).setFiles({ name: 'zaehlwerk.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('e2e-fake-image') })

    await expect(row.locator('input')).toHaveValue('2.468')
    await expect(row.locator('.row-info')).toHaveText('OCR 87%')
    expect(await readingsOf(meter.id)).toHaveLength(0)

    await row.getByRole('button', { name: 'Speichern' }).click()
    await expect(row.getByRole('button', { name: 'Gespeichert' })).toBeVisible()
    const [saved] = await readingsOf(meter.id)
    expect(saved.source).toBe('ocr')
    expect(saved.notes).toBe('OCR 87%')
  })

  test('ZAE-SCH-05 Alle eingegebenen Werte speichern', async ({ page }) => {
    const a = await createMeter({ name: uniqueName('E2E Schnell alle A') })
    const b = await createMeter({ name: uniqueName('E2E Schnell alle B') })
    const skipped = await createMeter({ name: uniqueName('E2E Schnell alle leer') })
    const failing = await createMeter({ name: uniqueName('E2E Schnell alle Fehler') })
    await addReading(failing.id, 500, daysAgo(5))
    await saveQuickEntry([a.id, b.id, skipped.id, failing.id])
    await openQuickEntry(page)

    const saveAll = page.getByRole('button', { name: 'Alle eingegebenen speichern' })
    await expect(saveAll).toBeDisabled()

    await typeNumber(entryRow(page, a.name).locator('input'), 7)
    await typeNumber(entryRow(page, b.name).locator('input'), 8)
    await typeNumber(entryRow(page, failing.name).locator('input'), 1)
    await saveAll.click()

    await expect(entryRow(page, a.name).getByRole('button', { name: 'Gespeichert' })).toBeVisible()
    await expect(entryRow(page, b.name).getByRole('button', { name: 'Gespeichert' })).toBeVisible()
    await expect(entryRow(page, failing.name).locator('.p-message-warn')).toContainText('previous reading')
    await expect(entryRow(page, skipped.name).getByRole('button', { name: 'Speichern' })).toBeVisible()
    expect(await readingsOf(skipped.id)).toHaveLength(0)
    expect((await readingsOf(a.id)).map((r) => r.value)).toEqual([7])
  })
})
