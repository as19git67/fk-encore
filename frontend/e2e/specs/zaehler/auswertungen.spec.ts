import { test, expect, type Page } from '@playwright/test'
import { adminApi } from '../../fixtures/api'
import { addReadingSeries, createMeter, createTariff, uniqueName } from '../../fixtures/meters'
import { choose, confirm, fillNumber, fillText, pageTitle } from '../../fixtures/ui'

// Zähler › Auswertungen (`AUS`) und Hilfe Gradtage (`HLF`),
// documentation/handbuch/zaehler.md.

async function openReports(page: Page) {
  await page.goto('zaehler/auswertungen')
  await expect(pageTitle(page, 'Auswertungen')).toBeVisible()
  await expect(page.getByText('Auswertungen werden geladen…')).toHaveCount(0)
}

async function openTariffs(page: Page) {
  await openReports(page)
  await page.getByRole('button', { name: 'Tarife & Annahmen' }).click()
  const dialog = page.getByRole('dialog', { name: 'Tarife & Annahmen verwalten' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Tarife & Annahmen…')).toHaveCount(0)
  return dialog
}

function tariffCard(dialog: ReturnType<Page['getByRole']>, name: string) {
  return dialog.locator('.tariff-card').filter({ hasText: name })
}

test.describe('Zähler › Auswertungen', () => {
  test('ZAE-AUS-01 Zur Zählerliste wechseln', async ({ page }) => {
    await createMeter({ name: uniqueName('E2E Auswertung Liste') })
    await openReports(page)
    await page.locator('.page-actions').getByRole('button', { name: 'Zähler', exact: true }).click()
    await expect(page).toHaveURL(/\/zaehler$/)
  })

  test('ZAE-AUS-01 Ohne Zähler führt der Hinweis zur Verwaltung', async ({ page }) => {
    await page.route('**/meters', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { meters: [] } }) : route.continue(),
    )
    await openReports(page)
    await expect(page.getByText('Noch keine Zähler angelegt — ohne Ablesungen gibt es nichts auszuwerten.')).toBeVisible()
    await page.getByRole('button', { name: 'Zur Zählerverwaltung' }).click()
    await expect(page).toHaveURL(/\/zaehler$/)
  })

  test('ZAE-AUS-02 Trend-Kachel öffnen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Trend'), type: 'water' })
    await addReadingSeries(meter.id, { count: 15, everyDays: 30, step: 10 })
    await openReports(page)

    const tile = page.locator('.trend-tile').filter({ hasText: meter.name })
    await expect(tile).toBeVisible()
    await tile.click()
    await expect(page).toHaveURL(new RegExp(`/zaehler/${meter.id}$`))
    await expect(pageTitle(page, meter.name)).toBeVisible()
  })

  test.describe('Energie', () => {
    test.describe.configure({ mode: 'serial' })

    test.beforeAll(async () => {
      // A grid import, a feed-in and a PV meter, read on the same days.
      const roles = [
        { role: 'grid_import', step: 300 },
        { role: 'grid_export', step: 200 },
        { role: 'pv_production', step: 400 },
      ]
      for (const { role, step } of roles) {
        const meter = await createMeter({ name: uniqueName(`E2E Energie ${role}`), role })
        await addReadingSeries(meter.id, { count: 15, everyDays: 30, step })
      }
    })

    test('ZAE-AUS-03 Energiebericht umschalten', async ({ page }) => {
      await openReports(page)
      const section = page.locator('.energy-report-card')
      await expect(section.getByRole('heading', { name: 'Energie' })).toBeVisible()
      await expect(section).toContainText('Ø Bezug')
      await expect(section).toContainText('Ø Autarkie')
      await expect(section.locator('.energy-table th').first()).toHaveText('Monat')

      await section.getByRole('button', { name: 'Jahr', exact: true }).click()
      await expect(section.locator('.energy-table th').first()).toHaveText('Jahr')
    })

    test('ZAE-AUS-04 Hilfe zu den Energie-Kennzahlen', async ({ page }) => {
      await openReports(page)
      await page.locator('.energy-report-card').getByRole('button', { name: 'Hilfe' }).click()
      const dialog = page.getByRole('dialog', { name: 'Energie-Kennzahlen' })
      await expect(dialog).toContainText('Eigenverbrauchsquote')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    })
  })

  test('ZAE-AUS-05 Tarife und Annahmen öffnen', async ({ page }) => {
    const name = uniqueName('E2E Tarif sichtbar')
    await createTariff({ kind: 'grid_import', validFrom: '2024-01-01', amount: 0.3, unit: 'eur_per_kwh', name })
    const dialog = await openTariffs(page)

    await expect(dialog.locator('label', { hasText: 'Art' })).toBeVisible()
    const group = dialog.locator('.tariff-group').filter({ hasText: name })
    await expect(group.locator('.tariff-group-title')).toHaveText('Strom')
    await expect(tariffCard(dialog, name)).toContainText('ab 1.1.2024')
  })

  test('ZAE-AUS-06 Tarif oder Annahme anlegen', async ({ page }) => {
    const name = uniqueName('E2E Grundpreis')
    const dialog = await openTariffs(page)

    await choose(page, dialog, 'Art', 'Grundpreis')
    // The kind pre-fills its unit.
    await expect(dialog.locator('label', { hasText: 'Einheit' }).locator('.p-select')).toContainText('€/Monat')
    await fillNumber(dialog, 'Betrag', 12)
    await fillText(dialog, 'Name / Tarif', name)
    await dialog.locator('.tariff-form-actions').getByRole('button', { name: 'Speichern' }).click()

    await expect(tariffCard(dialog, name)).toContainText('Grundpreis')
    await expect(tariffCard(dialog, name)).toContainText('12,00')
    // The form is empty again.
    await expect(dialog.locator('label', { hasText: 'Name / Tarif' }).locator('input')).toHaveValue('')
  })

  test('ZAE-AUS-07 Tarif oder Annahme bearbeiten', async ({ page }) => {
    const name = uniqueName('E2E Tarif bearbeiten')
    const id = await createTariff({ kind: 'grid_import', validFrom: '2024-02-01', amount: 0.3, unit: 'eur_per_kwh', name })
    const dialog = await openTariffs(page)

    await tariffCard(dialog, name).locator('button:has(.pi-pencil)').click()
    await expect(dialog.locator('.tariff-edit-banner')).toContainText(`Bearbeite Preisänderung #${id}`)
    await fillNumber(dialog, 'Betrag', 0.35)
    await dialog.getByRole('button', { name: 'Änderung speichern' }).click()

    await expect(dialog.locator('.tariff-edit-banner')).toHaveCount(0)
    await expect(tariffCard(dialog, name)).toContainText('0,35')

    // "Abbrechen" in edit mode empties the form again.
    await tariffCard(dialog, name).locator('button:has(.pi-pencil)').click()
    await dialog.locator('.tariff-form-actions').getByRole('button', { name: 'Abbrechen' }).click()
    await expect(dialog.locator('.tariff-edit-banner')).toHaveCount(0)
  })

  test('ZAE-AUS-08 Tarif oder Annahme löschen', async ({ page }) => {
    const name = uniqueName('E2E Tarif löschen')
    await createTariff({ kind: 'grid_import', validFrom: '2024-03-01', amount: 0.3, unit: 'eur_per_kwh', name })
    const dialog = await openTariffs(page)

    await tariffCard(dialog, name).locator('button:has(.pi-trash)').click()
    await confirm(page, 'Strompreis löschen', 'Löschen')
    await expect(tariffCard(dialog, name)).toHaveCount(0)
  })

  test('ZAE-AUS-09 Benzinpreise abrufen', async ({ page }) => {
    // Fixed answer instead of the EU oil bulletin.
    await page.route('**/meters/petrol-prices/fetch', (route) =>
      route.fulfill({
        json: { from: '2025-01', to: '2025-06', monthsMissing: 6, monthsWritten: 6, monthsIncomplete: 0 },
      }),
    )
    const dialog = await openTariffs(page)
    await dialog.getByRole('button', { name: 'Benzinpreise abrufen' }).click()
    await expect(dialog.locator('.p-message-success')).toContainText(
      '6 von 6 fehlenden Monaten (2025-01 bis 2025-06) abgerufen.',
    )
  })

  test('ZAE-AUS-10 Preisreihen aus Datei importieren', async ({ page }) => {
    const name = uniqueName('E2E Import')
    const dialog = await openTariffs(page)
    const file = dialog.locator('input[type="file"]')

    await file.setInputFiles({
      name: 'preise.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          entries: [
            { kind: 'petrol_price', validFrom: '2020-01-01', amount: 1.5, unit: 'eur_per_l', name },
            { kind: 'petrol_price', validFrom: '2020-02-01', amount: 1.6, unit: 'eur_per_l', name },
          ],
        }),
      ),
    })
    await expect(dialog.locator('.p-message-success')).toContainText('Import aus preise.json: 2 neu, 0 aktualisiert.')
    await expect(tariffCard(dialog, name)).toHaveCount(2)

    // Not JSON: nothing is imported.
    await file.setInputFiles({ name: 'kaputt.json', mimeType: 'application/json', buffer: Buffer.from('{ kein json') })
    await expect(dialog.locator('.p-message-error')).toContainText('Die Datei ist kein gültiges JSON.')
  })

  test.describe('Wohnort für Gradtagzahlen', () => {
    // One home location per user: these run in order.
    test.describe.configure({ mode: 'serial' })

    test.beforeAll(async () => {
      const { ctx } = await adminApi()
      await ctx.delete('/meters/home-location')
    })

    function homeCard(page: Page) {
      return page.locator('.home-card')
    }

    test('ZAE-AUS-11 Wohnort für Gradtagzahlen setzen', async ({ page }) => {
      // Fixed answer instead of the geocoder.
      await page.route(/\/meters\/places\?/, (route) =>
        route.fulfill({
          json: { places: [{ name: 'Musterstadt', admin1: 'Beispielland', country: 'Deutschland', lat: 48.1, lon: 11.5 }] },
        }),
      )
      await openReports(page)
      const card = homeCard(page)
      await expect(card).toContainText('Noch kein Wohnort hinterlegt.')

      await card.getByPlaceholder('Ort suchen (Stadt oder Gemeinde)').fill('Musterstadt')
      await card.getByRole('button', { name: 'Suchen' }).click()
      await card.getByRole('button', { name: /Musterstadt, Beispielland, Deutschland/ }).click()
      await expect(card.locator('.home-current')).toContainText('Musterstadt, Beispielland, Deutschland')
      await expect(card.locator('.p-message-info')).toContainText('Wohnort gespeichert.')

      // The manual way: label and coordinates.
      await card.getByRole('button', { name: 'Koordinaten eingeben' }).click()
      await fillText(card, 'Bezeichnung', 'E2E Beispielort')
      await fillNumber(card, 'Breitengrad', 50.5)
      await fillNumber(card, 'Längengrad', 9.5)
      await card.locator('.manual-grid').getByRole('button', { name: 'Speichern' }).click()
      await expect(card.locator('.home-current')).toContainText('E2E Beispielort')
      await expect(card.locator('.home-current')).toContainText('50,50')
    })

    test('ZAE-AUS-12 Gradtagzahlen sofort abrufen', async ({ page }) => {
      // Fixed answer instead of the Open-Meteo archive.
      await page.route('**/meters/degree-days/fetch', (route) =>
        route.fulfill({ json: { from: '2025-01', to: '2025-03', monthsMissing: 3, monthsWritten: 0, monthsIncomplete: 3 } }),
      )
      await openReports(page)
      const card = homeCard(page)
      await card.getByRole('button', { name: 'Gradtagzahlen abrufen' }).click()
      await expect(card.locator('.p-message-info')).toContainText(
        '0 von 3 fehlenden Monaten (2025-01 bis 2025-03) abgerufen, 3 noch unvollständig im Archiv.',
      )
    })

    test('ZAE-AUS-13 Wohnort entfernen', async ({ page }) => {
      await openReports(page)
      const card = homeCard(page)
      await expect(card.locator('.home-current')).toBeVisible()
      await card.getByRole('button', { name: 'Entfernen' }).click()
      await expect(card).toContainText('Noch kein Wohnort hinterlegt.')
      await expect(card.getByRole('button', { name: 'Gradtagzahlen abrufen' })).toHaveCount(0)
    })
  })

  test('ZAE-AUS-14 Hilfe „Was sind Gradtage?“', async ({ page }) => {
    await createMeter({ name: uniqueName('E2E Auswertung Hilfe') })
    await openReports(page)
    await page.getByRole('button', { name: 'Was sind Gradtage?' }).click()
    await expect(page).toHaveURL(/\/zaehler\/hilfe\/gradtage$/)
    await expect(pageTitle(page, 'Gradtage und Witterungsbereinigung')).toBeVisible()
  })
})

test.describe('Zähler › Hilfe Gradtage', () => {
  test('ZAE-HLF-01 Hilfe lesen und zurück', async ({ page }) => {
    await createMeter({ name: uniqueName('E2E Hilfe') })

    // From the reports, the arrow goes back there …
    await openReports(page)
    await page.getByRole('button', { name: 'Was sind Gradtage?' }).click()
    await expect(page.getByText('„Wir haben mehr geheizt als letztes Jahr“')).toBeVisible()
    await page.getByTestId('page-back').getByRole('button', { name: 'Zurück' }).click()
    await expect(page).toHaveURL(/\/zaehler\/auswertungen$/)

    // … opened directly, it falls back to the list.
    await page.goto('zaehler/hilfe/gradtage')
    await expect(pageTitle(page, 'Gradtage und Witterungsbereinigung')).toBeVisible()
    await page.getByTestId('page-back').getByRole('button', { name: 'Zurück' }).click()
    await expect(page).toHaveURL(/\/zaehler$/)
  })
})
