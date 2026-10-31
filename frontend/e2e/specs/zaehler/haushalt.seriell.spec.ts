import { test, expect, type Page } from '@playwright/test'
import { createGroup, createMeter, setHousehold, uniqueName } from '../../fixtures/meters'
import { choose, pageTitle } from '../../fixtures/ui'

// Zähler › Liste: Haushalt (ZAE-LST-08, ZAE-LST-09),
// documentation/handbuch/zaehler.md. A household changes what every other
// Zähler test sees (default visibility of new meters, tariff scope), so this
// file runs in the `zaehler-seriell` project after all of them, in order.

test.describe.configure({ mode: 'serial' })

let groupName: string
let privateMeter: { id: number; name: string }

test.beforeAll(async () => {
  await setHousehold(null)
  groupName = uniqueName('E2E Haushalt')
  await createGroup(groupName)
  privateMeter = await createMeter({ name: uniqueName('E2E Haushalt privat') })
})

test.afterAll(async () => {
  await setHousehold(null)
})

async function openList(page: Page) {
  await page.goto('zaehler')
  await expect(pageTitle(page, 'Zähler')).toBeVisible()
  await expect(page.getByText('Zähler werden geladen…')).toHaveCount(0)
}

function card(page: Page, name: string) {
  return page.locator('.meter-card').filter({ hasText: name })
}

test.describe('Zähler › Haushalt', () => {
  test('ZAE-LST-08 Haushalt festlegen', async ({ page }) => {
    await openList(page)
    await page.getByRole('button', { name: 'Haushalt', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Haushalt', exact: true })
    await expect(dialog).toContainText('Zähler gehören meist dem ganzen Haushalt.')
    // Nothing changed yet.
    await expect(dialog.getByRole('button', { name: 'Speichern' })).toBeDisabled()

    await choose(page, dialog, 'Gruppe', groupName)
    await dialog.getByRole('button', { name: 'Speichern' }).click()
    await expect(dialog).toBeHidden()

    // The private meters are now pointed out …
    await expect(page.getByText(/noch privat und für den Haushalt „.*“ unsichtbar\./)).toBeVisible()

    // … and a new meter belongs to the household unless picked otherwise.
    await page.getByRole('button', { name: 'Neuer Zähler' }).click()
    const form = page.getByRole('dialog', { name: 'Neuer Zähler' })
    await expect(form.locator('label', { hasText: 'Sichtbarkeit' }).locator('.p-select')).toContainText(
      `${groupName} (Haushalt)`,
    )
    await form.getByRole('button', { name: 'Abbrechen' }).click()
  })

  test('ZAE-LST-09 Alle privaten Zähler mit dem Haushalt teilen', async ({ page }) => {
    await openList(page)
    await expect(card(page, privateMeter.name)).toContainText('Privat')

    await page.getByRole('button', { name: 'Alle mit dem Haushalt teilen' }).click()
    await expect(page.locator('.p-message-success')).toContainText('mit dem Haushalt geteilt.')
    await expect(page.getByRole('button', { name: 'Alle mit dem Haushalt teilen' })).toHaveCount(0)
    await expect(card(page, privateMeter.name)).toContainText(`Haushalt „${groupName}“`)
  })
})
