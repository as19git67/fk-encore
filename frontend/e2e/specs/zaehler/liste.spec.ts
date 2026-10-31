import { test, expect, type Page } from '@playwright/test'
import { addReading, createCollection, createMeter, daysAgo, getMeter, uniqueName } from '../../fixtures/meters'
import { choose, confirm, fillNumber, fillText, pageTitle } from '../../fixtures/ui'

// Zähler › Liste (`/zaehler`), documentation/handbuch/zaehler.md, section LST.
// Haushalt (LST-08, LST-09) changes state every list shares and lives in
// haushalt.seriell.spec.ts.

function card(page: Page, name: string) {
  return page.locator('.meter-card').filter({ hasText: name })
}

async function openList(page: Page) {
  await page.goto('zaehler')
  await expect(pageTitle(page, 'Zähler')).toBeVisible()
  await expect(page.getByText('Zähler werden geladen…')).toHaveCount(0)
}

test.describe('Zähler › Liste', () => {
  test('ZAE-LST-01 Zähler öffnen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Liste öffnen') })
    await openList(page)

    await card(page, meter.name).click()
    await expect(page).toHaveURL(new RegExp(`/zaehler/${meter.id}$`))
    await expect(pageTitle(page, meter.name)).toBeVisible()

    // Back to the list: the anchor puts the focus back on this tile.
    await page.getByRole('button', { name: 'Zurück' }).click()
    await expect(page).toHaveURL(/\/zaehler$/)
    await expect(card(page, meter.name)).toBeVisible()

    // Keyboard: Enter on a focused tile opens it as well.
    await card(page, meter.name).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/zaehler/${meter.id}$`))
  })

  test('ZAE-LST-01 Knöpfe in der Kachel öffnen den Zähler nicht', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Liste Knöpfe') })
    await openList(page)

    await card(page, meter.name).getByRole('button', { name: 'Bearbeiten' }).click()
    const dialog = page.getByRole('dialog', { name: 'Zähler bearbeiten' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/zaehler$/)
  })

  test('ZAE-LST-02 Zu den Auswertungen wechseln', async ({ page }) => {
    await openList(page)
    await page.locator('.page-actions').getByRole('button', { name: 'Auswertungen' }).click()
    await expect(page).toHaveURL(/\/zaehler\/auswertungen$/)
    await expect(pageTitle(page, 'Auswertungen')).toBeVisible()
  })

  test('ZAE-LST-03 Zähler anlegen', async ({ page }) => {
    const name = uniqueName('E2E Wasser angelegt')
    await openList(page)

    await page.getByRole('button', { name: 'Neuer Zähler' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neuer Zähler' })
    await expect(dialog).toBeVisible()
    // The focus starts in "Name".
    await expect(dialog.locator('label', { hasText: 'Name' }).locator('input')).toBeFocused()

    await fillText(dialog, 'Name', name)
    await choose(page, dialog, 'Typ', 'Wasser')
    // Switching the type pre-fills the matching unit.
    await expect(dialog.locator('label', { hasText: 'Einheit' }).locator('input')).toHaveValue('m³')
    await fillText(dialog, 'Standort', 'Keller')
    await fillText(dialog, 'Seriennummer', 'E2E-SN-0001')
    await fillNumber(dialog, 'Startwert', 12)
    await dialog.getByRole('button', { name: 'Speichern' }).click()

    await expect(dialog).toBeHidden()
    const tile = card(page, name)
    await expect(tile).toBeVisible()
    await expect(tile).toContainText('Wasser')
    await expect(tile).toContainText('Keller')

    await tile.click()
    await expect(page.locator('.figures-bar')).toContainText('E2E-SN-0001')
    await expect(page.locator('.figures-bar')).toContainText('12')
  })

  test('ZAE-LST-03 Leerer Name wird abgewiesen, Abbrechen verwirft', async ({ page }) => {
    await openList(page)

    await page.getByRole('button', { name: 'Neuer Zähler' }).click()
    const dialog = page.getByRole('dialog', { name: 'Neuer Zähler' })
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(page.locator('.p-message-error')).toContainText('Name darf nicht leer sein')
    // The dialog stays open with what was entered.
    await expect(dialog).toBeVisible()

    // Cancel discards what was typed.
    await fillText(dialog, 'Name', 'E2E verworfen')
    await dialog.getByRole('button', { name: 'Abbrechen' }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Neuer Zähler' }).click()
    await expect(dialog.locator('label', { hasText: 'Name' }).locator('input')).toHaveValue('')
  })

  test('ZAE-LST-04 Zähler bearbeiten', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Liste bearbeiten') })
    const renamed = `${meter.name} neu`
    await openList(page)

    await card(page, meter.name).getByRole('button', { name: 'Bearbeiten' }).click()
    const dialog = page.getByRole('dialog', { name: 'Zähler bearbeiten' })
    // Editing shows the master data only, without the device part.
    await expect(dialog.getByText('Erstes Gerät')).toHaveCount(0)
    await fillText(dialog, 'Name', renamed)
    await fillText(dialog, 'Standort', 'Garage')
    await dialog.getByRole('button', { name: 'Speichern' }).click()

    await expect(dialog).toBeHidden()
    await expect(card(page, renamed)).toContainText('Garage')
  })

  test('ZAE-LST-05 Zähler löschen', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Liste löschen') })
    await addReading(meter.id, 5, daysAgo(3))
    await openList(page)

    // Cancel leaves everything as it was.
    await card(page, meter.name).getByRole('button', { name: 'Löschen' }).click()
    const ask = page.getByRole('alertdialog', { name: 'Zähler löschen' })
    await expect(ask).toContainText(`Zähler „${meter.name}“ mit allen Geräten und Ablesungen löschen?`)
    await ask.getByRole('button', { name: 'Abbrechen' }).click()
    await expect(card(page, meter.name)).toBeVisible()

    await card(page, meter.name).getByRole('button', { name: 'Löschen' }).click()
    await confirm(page, 'Zähler löschen', 'Endgültig löschen')
    await expect(card(page, meter.name)).toHaveCount(0)
    await expect(getMeter(meter.id)).rejects.toThrow(/404|not_found/)
  })

  test('ZAE-LST-06 Zähler ablegen (Basket oder Sammelmappe)', async ({ page }) => {
    const meter = await createMeter({ name: uniqueName('E2E Liste ablegen') })
    const folder = uniqueName('E2E Mappe Zähler')
    await openList(page)

    await card(page, meter.name).getByTestId('file-button').click()
    const dialog = page.getByRole('dialog', { name: 'Ablegen' })
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('atc-basket').click()
    await expect(dialog.getByTestId('atc-basket')).toContainText('Im Basket')

    await dialog.getByRole('textbox', { name: 'Name der neuen Sammelmappe' }).fill(folder)
    await dialog.getByRole('button', { name: 'Anlegen' }).click()
    await expect(dialog.getByRole('button', { name: new RegExp(folder) })).toHaveAttribute('aria-pressed', 'true')

    await dialog.getByRole('button', { name: 'Fertig' }).click()
    await expect(card(page, meter.name).getByTestId('file-button')).toHaveAccessibleName('Ablegen (liegt im Basket)')

    // Take it out again so the shared basket stays as it was.
    await card(page, meter.name).getByTestId('file-button').click()
    await dialog.getByTestId('atc-basket').click()
    await expect(dialog.getByTestId('atc-basket')).toContainText('In den Basket')
    await dialog.getByRole('button', { name: 'Fertig' }).click()
  })

  test('ZAE-LST-07 Liste auf eine Sammelmappe einschränken', async ({ page }) => {
    const inside = await createMeter({ name: uniqueName('E2E in Mappe') })
    const outside = await createMeter({ name: uniqueName('E2E außerhalb') })
    const folderName = uniqueName('E2E Mappe Filter')
    const folder = await createCollection(folderName, [inside.id])

    await page.goto(`zaehler?collection=${folder}`)
    const scope = page.getByTestId('collection-scope')
    await expect(scope).toContainText(`Sammelmappe: ${folderName}`)
    await expect(card(page, inside.name)).toBeVisible()
    await expect(card(page, outside.name)).toHaveCount(0)

    await scope.getByRole('button', { name: 'Sammelmappen-Filter entfernen' }).click()
    await expect(scope).toHaveCount(0)
    await expect(card(page, outside.name)).toBeVisible()
  })

  test('ZAE-LST-07 Leere Sammelmappe', async ({ page }) => {
    const folder = await createCollection(uniqueName('E2E Mappe leer'), [])
    await page.goto(`zaehler?collection=${folder}`)
    await expect(page.getByText('In dieser Sammelmappe liegen keine Zähler.')).toBeVisible()
  })

  test('ZAE-LST-10 Leere Liste', async ({ page }) => {
    // Other specs create meters in the same database, so the empty list is
    // what the server answers here, not what the database holds.
    await page.route('**/meters', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { meters: [] } }) : route.continue(),
    )
    await openList(page)
    await expect(page.getByText('Noch keine Zähler angelegt.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Neuer Zähler' })).toBeVisible()
  })
})
