import { test, expect, type Page } from '@playwright/test'
import { adminApi } from '../../fixtures/api'
import {
  addReading,
  addReadingSeries,
  createApiKey,
  createMeter,
  daysAgo,
  getMeter,
  uniqueName,
} from '../../fixtures/meters'
import { confirm, fillNumber, fillText, fmtValue, pageTitle } from '../../fixtures/ui'

// Zähler › Zählerdetails (`/zaehler/:id`), documentation/handbuch/zaehler.md,
// section DET.

async function openDetail(page: Page, meter: { id: number; name: string }) {
  await page.goto(`zaehler/${meter.id}`)
  await expect(pageTitle(page, meter.name)).toBeVisible()
  await expect(page.getByText('Wird geladen…')).toHaveCount(0)
}

function actions(page: Page) {
  return page.locator('.page-actions')
}

function iconButton(scope: ReturnType<Page['locator']>, icon: string) {
  return scope.locator(`button:has(.${icon})`)
}

function readingRows(page: Page) {
  return page.locator('.readings-table tbody tr')
}

function deviceRows(page: Page) {
  return page.locator('.device-table tbody tr')
}

function figure(page: Page, label: string) {
  return page.locator('.figures-bar .figure').filter({ hasText: label })
}

test.describe('Zähler › Details', () => {
  test('ZAE-DET-01 Zurück', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail zurück') })

    // Opened from the list: back returns to it.
    await page.goto('zaehler')
    await page.locator('.meter-card').filter({ hasText: meter.name }).click()
    await expect(pageTitle(page, meter.name)).toBeVisible()
    await page.getByTestId('page-back').getByRole('button', { name: 'Zurück' }).click()
    await expect(page).toHaveURL(/\/zaehler$/)

    // Opened directly (no previous page in the module): back falls back to the list.
    await openDetail(page, meter)
    await page.getByTestId('page-back').getByRole('button', { name: 'Zurück' }).click()
    await expect(page).toHaveURL(/\/zaehler$/)
    await expect(pageTitle(page, 'Zähler')).toBeVisible()
  })

  test('ZAE-DET-02 Link teilen', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const meter = await createMeter({ name: uniqueName('E2E Detail Link') })
    await openDetail(page, meter)

    await actions(page).getByRole('button', { name: 'Link teilen' }).click()
    await expect(actions(page).getByRole('button', { name: 'Link kopiert' })).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toMatch(new RegExp(`/zaehler/${meter.id}$`))
  })

  test('ZAE-DET-03 Zähler ablegen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail ablegen') })
    await openDetail(page, meter)

    await actions(page).getByTestId('file-button').click()
    const dialog = page.getByRole('dialog', { name: 'Ablegen' })
    await dialog.getByTestId('atc-basket').click()
    await expect(dialog.getByTestId('atc-basket')).toContainText('Im Basket')
    await dialog.getByRole('button', { name: 'Fertig' }).click()
    await expect(actions(page).getByTestId('file-button')).toHaveAccessibleName('Ablegen (liegt im Basket)')

    // Leave the shared basket as it was.
    await actions(page).getByTestId('file-button').click()
    await dialog.getByTestId('atc-basket').click()
    await expect(dialog.getByTestId('atc-basket')).toContainText('In den Basket')
    await dialog.getByRole('button', { name: 'Fertig' }).click()
  })

  test('ZAE-DET-04 Zähler bearbeiten', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail bearbeiten') })
    const renamed = `${meter.name} neu`
    await openDetail(page, meter)

    await iconButton(actions(page), 'pi-pencil').click()
    const dialog = page.getByRole('dialog', { name: 'Zähler bearbeiten' })
    await fillText(dialog, 'Name', renamed)
    await fillText(dialog, 'Standort', 'Dachboden')
    await dialog.getByRole('button', { name: 'Speichern' }).click()

    await expect(dialog).toBeHidden()
    await expect(pageTitle(page, renamed)).toBeVisible()
    await expect(page.locator('.detail-subtitle')).toContainText('Dachboden')
  })

  test('ZAE-DET-05 Zähler löschen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail löschen') })
    await openDetail(page, meter)

    await iconButton(actions(page), 'pi-trash').click()
    await confirm(page, 'Zähler löschen', 'Endgültig löschen')
    await expect(page).toHaveURL(/\/zaehler$/)
    await expect(page.locator('.meter-card').filter({ hasText: meter.name })).toHaveCount(0)
  })

  test('ZAE-DET-06 Verbrauchsreport umschalten', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Report') })
    // Fifteen months, one reading a month, the same consumption each time.
    await addReadingSeries(meter.id, { count: 15, everyDays: 30, step: 100 })
    await openDetail(page, meter)

    const report = page.locator('.report-panel')
    await expect(report).toContainText('Ø Verbrauch')
    await expect(report.locator('th').first()).toHaveText('Monat')

    await page.getByRole('button', { name: 'Jahr', exact: true }).click()
    await expect(report.locator('th').first()).toHaveText('Jahr')
    await page.getByRole('button', { name: 'Woche', exact: true }).click()
    await expect(report.locator('th').first()).toHaveText('Woche')
    await expect(report).toContainText(/Basis: \d+ abgeschlossene/)
  })

  test('ZAE-DET-06 Zu wenige Ablesungen für einen Report', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail ohne Report') })
    await addReading(meter.id, 10, daysAgo(2))
    await openDetail(page, meter)
    await expect(page.getByText('Noch nicht genug Ablesungen für einen Verbrauchsreport.')).toBeVisible()
  })

  test('ZAE-DET-07 Gerät ersetzen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Gerätewechsel'), serialNumber: 'E2E-ALT-1' })
    await addReading(meter.id, 100, daysAgo(3))
    await openDetail(page, meter)

    await page.getByRole('button', { name: 'Gerät ersetzen' }).click()
    const dialog = page.getByRole('dialog', { name: 'Gerät ersetzen' })
    await fillNumber(dialog, 'Endstand altes Gerät', 150)
    await fillText(dialog, 'Seriennummer neu', 'E2E-NEU-1')
    await fillNumber(dialog, 'Startwert neu', 0)
    await dialog.getByRole('button', { name: 'Ersetzen' }).click()
    await expect(dialog).toBeHidden()

    await expect(deviceRows(page)).toHaveCount(2)
    await expect(deviceRows(page).filter({ hasText: 'E2E-ALT-1' })).toContainText('ersetzt')
    await expect(deviceRows(page).filter({ hasText: 'E2E-NEU-1' })).toContainText('aktiv')
    await expect(figure(page, 'Aktives Gerät')).toContainText('E2E-NEU-1')
    // The absolute total runs on across the swap.
    await expect(figure(page, 'Gesamt (absolut)')).toContainText(fmtValue(150))
    expect((await getMeter(meter.id)).absoluteTotal).toBe(150)
  })

  test('ZAE-DET-07 Endstand unter der letzten Ablesung wird abgewiesen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Wechsel abgewiesen') })
    await addReading(meter.id, 100, daysAgo(3))
    await openDetail(page, meter)

    await page.getByRole('button', { name: 'Gerät ersetzen' }).click()
    const dialog = page.getByRole('dialog', { name: 'Gerät ersetzen' })
    await fillNumber(dialog, 'Endstand altes Gerät', 50)
    await dialog.getByRole('button', { name: 'Ersetzen' }).click()

    await expect(page.locator('.p-message-error')).toContainText('must be >= the last reading')
    expect((await getMeter(meter.id)).devices).toHaveLength(1)
  })

  test('ZAE-DET-08 Gerät bearbeiten', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Gerät bearbeiten'), serialNumber: 'E2E-SN-A' })
    await openDetail(page, meter)

    await iconButton(deviceRows(page).first(), 'pi-pencil').click()
    const dialog = page.getByRole('dialog', { name: 'Gerät bearbeiten' })
    await fillText(dialog, 'Seriennummer', 'E2E-SN-B')
    await fillNumber(dialog, 'Startwert', 5)
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(dialog).toBeHidden()

    await expect(deviceRows(page).first()).toContainText('E2E-SN-B')
    await expect(figure(page, 'Aktives Gerät')).toContainText('E2E-SN-B')
  })

  test('ZAE-DET-09 Neuestes Gerät löschen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Gerät löschen'), serialNumber: 'E2E-ERST' })
    await addReading(meter.id, 40, daysAgo(5))
    const { ctx } = await adminApi()
    const swap = await ctx.post(`/meters/${meter.id}/replace-device`, {
      data: { swapAt: daysAgo(1).toISOString(), finalValue: 40, newSerialNumber: 'E2E-ZWEIT', newStartValue: 0 },
    })
    expect(swap.ok()).toBeTruthy()
    await openDetail(page, meter)

    // The first device has readings and is not the newest.
    await expect(iconButton(deviceRows(page).filter({ hasText: 'E2E-ERST' }), 'pi-trash')).toBeDisabled()

    await iconButton(deviceRows(page).filter({ hasText: 'E2E-ZWEIT' }), 'pi-trash').click()
    await confirm(page, 'Gerät löschen', 'Löschen')

    await expect(deviceRows(page)).toHaveCount(1)
    await expect(deviceRows(page).first()).toContainText('E2E-ERST')
    await expect(deviceRows(page).first()).toContainText('aktiv')
  })

  test('ZAE-DET-10 Ablesung erfassen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Ablesung') })
    await addReading(meter.id, 100, daysAgo(5))
    await openDetail(page, meter)

    await actions(page).getByRole('button', { name: 'Neue Ablesung' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neue Ablesung' })
    await expect(dialog.locator('label', { hasText: 'Zählerstand' }).locator('input')).toBeFocused()
    await fillNumber(dialog, 'Zählerstand', 120)
    await fillText(dialog, 'Notiz', 'E2E Rundgang')
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(dialog).toBeHidden()

    const newest = readingRows(page).first()
    await expect(newest).toContainText(fmtValue(120))
    await expect(newest).toContainText('manual')
    await expect(newest).toContainText('E2E Rundgang')
    await expect(figure(page, 'Letzter Stand')).toContainText(fmtValue(120))
  })

  test('ZAE-DET-10 Wert unter der vorigen Ablesung wird abgewiesen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Ablesung abgewiesen') })
    await addReading(meter.id, 100, daysAgo(5))
    await openDetail(page, meter)

    await actions(page).getByRole('button', { name: 'Neue Ablesung' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neue Ablesung' })
    await fillNumber(dialog, 'Zählerstand', 50)
    await dialog.getByRole('button', { name: 'Speichern' }).click()

    await expect(page.locator('.p-message-error')).toContainText('must be >= the previous reading')
    await page.keyboard.press('Escape')
    await expect(readingRows(page)).toHaveCount(1)
  })

  test('ZAE-DET-11 Zählerstand per Foto erkennen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail OCR') })
    // Fixed answer instead of the OCR service.
    await page.route('**/meters/*/readings/ocr', (route) =>
      route.fulfill({ json: { value: 4321, confidence: 0.87, photoPath: '', rawText: '4321' } }),
    )
    await openDetail(page, meter)

    await actions(page).getByRole('button', { name: 'Neue Ablesung' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neue Ablesung' })
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'zaehlwerk.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('e2e-fake-image'),
    })

    await expect(dialog.locator('label', { hasText: 'Zählerstand' }).locator('input')).toHaveValue(fmtValue(4321))
    await expect(dialog.locator('label', { hasText: 'Notiz' }).locator('textarea')).toHaveValue('OCR (87%)')
    // Only a suggestion: nothing is stored before "Speichern".
    await expect(readingRows(page)).toHaveCount(0)
  })

  test('ZAE-DET-11 Kein Wert erkannt', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail OCR leer') })
    await page.route('**/meters/*/readings/ocr', (route) =>
      route.fulfill({ json: { value: null, confidence: 0, photoPath: '', rawText: '' } }),
    )
    await openDetail(page, meter)

    await actions(page).getByRole('button', { name: 'Neue Ablesung' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neue Ablesung' })
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'zaehlwerk.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('e2e-fake-image'),
    })
    await expect(dialog.locator('.p-message-warn')).toContainText('Kein Zählerstand erkannt. Bitte manuell eingeben.')
  })

  test('ZAE-DET-12 Ablesung bearbeiten', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Ablesung bearbeiten') })
    await addReading(meter.id, 70, daysAgo(4), 'E2E alt')
    await openDetail(page, meter)

    await iconButton(readingRows(page).first(), 'pi-pencil').click()
    const dialog = page.getByRole('dialog', { name: 'Ablesung bearbeiten' })
    // Editing has no camera.
    await expect(iconButton(dialog, 'pi-camera')).toHaveCount(0)
    await fillNumber(dialog, 'Zählerstand', 75)
    await fillText(dialog, 'Notiz', 'E2E korrigiert')
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(dialog).toBeHidden()

    await expect(readingRows(page).first()).toContainText(fmtValue(75))
    await expect(readingRows(page).first()).toContainText('E2E korrigiert')
    await expect(figure(page, 'Letzter Stand')).toContainText(fmtValue(75))
  })

  test('ZAE-DET-13 Ablesung löschen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Ablesung löschen') })
    await addReading(meter.id, 10, daysAgo(6))
    await addReading(meter.id, 20, daysAgo(3))
    await openDetail(page, meter)
    await expect(readingRows(page)).toHaveCount(2)

    await iconButton(readingRows(page).first(), 'pi-trash').click()
    await confirm(page, 'Ablesung löschen', 'Löschen')

    await expect(readingRows(page)).toHaveCount(1)
    await expect(figure(page, 'Letzter Stand')).toContainText(fmtValue(10))
  })

  test('ZAE-DET-14 Ablesung ablegen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Ablesung ablegen') })
    await addReading(meter.id, 33, daysAgo(2))
    await openDetail(page, meter)

    const fileButton = readingRows(page).first().getByTestId('file-button')
    await fileButton.click()
    const dialog = page.getByRole('dialog', { name: 'Ablegen' })
    await dialog.getByTestId('atc-basket').click()
    await expect(dialog.getByTestId('atc-basket')).toContainText('Im Basket')
    await dialog.getByRole('button', { name: 'Fertig' }).click()
    await expect(fileButton).toHaveAccessibleName('Ablegen (liegt im Basket)')
    // The meter itself is not in the basket.
    await expect(actions(page).getByTestId('file-button')).toHaveAccessibleName('Ablegen: Basket oder Sammelmappe')

    await fileButton.click()
    await dialog.getByTestId('atc-basket').click()
    await expect(dialog.getByTestId('atc-basket')).toContainText('In den Basket')
    await dialog.getByRole('button', { name: 'Fertig' }).click()
  })

  test('ZAE-DET-15 Durch die Ablesungen blättern', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail blättern') })
    await addReadingSeries(meter.id, { count: 25, everyDays: 1, step: 1 })
    await openDetail(page, meter)

    await expect(readingRows(page)).toHaveCount(20)
    // Newest first.
    await expect(readingRows(page).first()).toContainText(fmtValue(25))

    await page.locator('.readings-table .p-paginator-page', { hasText: /^2$/ }).click()
    await expect(readingRows(page)).toHaveCount(5)
    await expect(readingRows(page).last()).toContainText(fmtValue(1))
  })

  test('ZAE-DET-16 Zahlung mit einer Ablesung verknüpfen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Zahlung') })
    await addReading(meter.id, 12, daysAgo(2))
    await openDetail(page, meter)

    await iconButton(readingRows(page).first(), 'pi-link').click()
    const dialog = page.getByRole('dialog', { name: 'Zahlungen zur Ablesung' })
    await expect(dialog).toContainText('Noch keine Zahlung verknüpft.')

    // The demo seed (E2E_SEED_DEMO=1) lays down this booking.
    await dialog.getByPlaceholder(/Empfänger, Verwendungszweck oder Betrag/).fill('E2E Demo Supermarkt')
    const searched = page.waitForResponse((r) => r.url().includes('/finance/transactions?'))
    await dialog.getByRole('button', { name: 'Suchen' }).click()
    await searched
    await expect(dialog.getByText('Suche…')).toHaveCount(0)
    const hit = dialog.locator('.tx-list').last().locator('.tx-row').filter({ hasText: 'E2E Demo Supermarkt' }).first()
    test.skip((await hit.count()) === 0, 'Keine Demo-Buchung vorhanden (E2E_SEED_DEMO nicht gesetzt)')
    await iconButton(hit, 'pi-link').click()

    await expect(dialog.locator('.tx-list').first()).toContainText('E2E Demo Supermarkt')
    await dialog.getByRole('button', { name: 'Schließen' }).click()
    await expect(iconButton(readingRows(page).first(), 'pi-euro')).toContainText('1')
  })

  test('ZAE-DET-17 Verknüpfung einer Zahlung lösen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail Zahlung lösen') })
    const readingId = await addReading(meter.id, 12, daysAgo(2))
    const { ctx } = await adminApi()
    const found = await ctx.get('/finance/transactions', { params: { q: 'E2E Demo Supermarkt', limit: 1 } })
    const items = found.ok() ? ((await found.json()) as { items: Array<{ id: number }> }).items : []
    test.skip(items.length === 0, 'Keine Demo-Buchung vorhanden (E2E_SEED_DEMO nicht gesetzt)')
    const link = await ctx.post(`/meters/readings/${readingId}/transactions`, { data: { transactionId: items[0].id } })
    expect(link.ok()).toBeTruthy()
    await openDetail(page, meter)

    await iconButton(readingRows(page).first(), 'pi-euro').click()
    const dialog = page.getByRole('dialog', { name: 'Zahlungen zur Ablesung' })
    const linked = dialog.locator('.tx-list').first().locator('.tx-row').filter({ hasText: 'E2E Demo Supermarkt' })
    await iconButton(linked, 'pi-times').click()

    await expect(dialog).toContainText('Noch keine Zahlung verknüpft.')
    await dialog.getByRole('button', { name: 'Schließen' }).click()
    await expect(iconButton(readingRows(page).first(), 'pi-link')).toBeVisible()
  })

  test('ZAE-DET-18 API-Schlüssel anlegen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail API-Key') })
    await openDetail(page, meter)
    await expect(page.getByText('Keine API-Keys vorhanden.')).toBeVisible()

    await page.getByRole('button', { name: 'Neuer Key' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neuer API-Key' })
    await expect(dialog.getByRole('button', { name: 'Erstellen' })).toBeDisabled()
    await dialog.getByPlaceholder('z.B. Shelly EM').fill('E2E Messgerät')
    await dialog.getByRole('button', { name: 'Erstellen' }).click()

    await expect(dialog).toContainText('Der Token wird nur einmal angezeigt. Jetzt kopieren!')
    await expect(dialog.locator('.token-display code')).not.toBeEmpty()
    await dialog.getByRole('button', { name: 'Schließen' }).click()

    const row = page.locator('.keys-table tbody tr').filter({ hasText: 'E2E Messgerät' })
    await expect(row).toContainText('nie')
    await expect(row).toContainText('aktiv')
  })

  test('ZAE-DET-19 API-Schlüssel löschen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Detail API-Key löschen') })
    await createApiKey(meter.id, 'E2E Altgerät')
    await openDetail(page, meter)

    const row = page.locator('.keys-table tbody tr').filter({ hasText: 'E2E Altgerät' })
    await iconButton(row, 'pi-trash').click()
    await confirm(page, 'API-Key löschen', 'Löschen')
    await expect(page.getByText('Keine API-Keys vorhanden.')).toBeVisible()
  })

  test('ZAE-DET-20 Unbekannter Zähler', async ({ page }) => {
    await page.goto('zaehler/999999999')
    await expect(page.getByText('Zähler nicht gefunden.')).toBeVisible()
    await expect(actions(page).getByRole('button', { name: 'Neue Ablesung' })).toHaveCount(0)
  })
})
