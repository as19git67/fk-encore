import { test, expect, type Page } from '@playwright/test'
import { addReading, addReadingSeries, createMeter, daysAgo, runAnomalyCheck, uniqueName } from '../../fixtures/meters'
import { pageTitle } from '../../fixtures/ui'

// Zähler › Auffälligkeiten (`/zaehler/auffaelligkeiten`),
// documentation/handbuch/zaehler.md, section AUF. The inbox is per user, so
// the tests run in order on the findings seeded below.

test.describe.configure({ mode: 'serial' })

/** Weekly readings at a flat rate, then one interval ten times as high. */
async function seedSpike(name: string) {
  const meter = await createMeter({ name })
  await addReadingSeries(meter.id, { count: 8, everyDays: 7, step: 70, endDaysAgo: 8 })
  await addReading(meter.id, 8 * 70 + 700, daysAgo(1))
  return meter
}

/** An operating-hours counter that ran every week and then stood still. */
async function seedStandstill(name: string) {
  const meter = await createMeter({ name, type: 'operating_hours' })
  await addReadingSeries(meter.id, { count: 8, everyDays: 7, step: 20, endDaysAgo: 12 })
  await addReading(meter.id, 8 * 20, daysAgo(1))
  return meter
}

function anomalyCard(page: Page, meterName: string) {
  return page.locator('.anomaly-card').filter({ hasText: meterName })
}

async function openInbox(page: Page, query = '') {
  await page.goto(`zaehler/auffaelligkeiten${query}`)
  await expect(pageTitle(page, 'Zähler-Auffälligkeiten')).toBeVisible()
}

async function pick(page: Page, select: string, option: string) {
  await page.getByRole('combobox', { name: select }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

let spike: { id: number; name: string }
let standstill: { id: number; name: string }

test.beforeAll(async () => {
  spike = await seedSpike(uniqueName('E2E Auffällig Sprung'))
  standstill = await seedStandstill(uniqueName('E2E Auffällig Stillstand'))
  await runAnomalyCheck()
})

test.describe('Zähler › Auffälligkeiten', () => {
  test('ZAE-AUF-03 Prüfung sofort ausführen', async ({ page }) => {
    const fresh = await seedSpike(uniqueName('E2E Auffällig neu'))
    await openInbox(page)
    await expect(anomalyCard(page, fresh.name)).toHaveCount(0)

    await page.getByRole('button', { name: 'Jetzt prüfen' }).click()
    await expect(anomalyCard(page, fresh.name)).toHaveCount(1)
    await expect(anomalyCard(page, fresh.name)).toContainText('Verbrauchssprung')

    // A second run does not duplicate a known finding.
    await page.getByRole('button', { name: 'Jetzt prüfen' }).click()
    await expect(page.getByRole('button', { name: 'Jetzt prüfen' })).toBeEnabled()
    await expect(anomalyCard(page, fresh.name)).toHaveCount(1)
  })

  test('ZAE-AUF-01 Filtern', async ({ page }) => {
    await openInbox(page)
    await expect(anomalyCard(page, spike.name)).toContainText('Verbrauchssprung')
    await expect(anomalyCard(page, standstill.name)).toContainText('Stillstand')

    await pick(page, 'Art der Auffälligkeit', 'Stillstand')
    await expect(page).toHaveURL(/type=standstill/)
    await expect(anomalyCard(page, standstill.name)).toBeVisible()
    await expect(anomalyCard(page, spike.name)).toHaveCount(0)

    // The filter lives in the URL: a reload shows the same list.
    await page.reload()
    await expect(anomalyCard(page, standstill.name)).toBeVisible()
    await expect(anomalyCard(page, spike.name)).toHaveCount(0)

    // "Alle" adds a status chip to every card.
    await pick(page, 'Umfang', 'Alle')
    await expect(page).toHaveURL(/scope=all/)
    await expect(anomalyCard(page, standstill.name)).toContainText('Offen')

    // Filtered down to nothing: the empty state offers to reset.
    await pick(page, 'Art der Auffälligkeit', 'Rückläufiger Zählerstand')
    await expect(page.getByText('Mit anderen Filtereinstellungen findet sich vielleicht etwas.')).toBeVisible()
    await page.getByTestId('empty-clear-filters').click()
    await expect(anomalyCard(page, spike.name)).toBeVisible()
    await expect(page).not.toHaveURL(/type=/)
  })

  test('ZAE-AUF-02 Liste neu laden', async ({ page }) => {
    await openInbox(page)
    const reload = page.waitForResponse((r) => r.url().includes('/meters/anomalies?'))
    await page.getByRole('button', { name: 'Aktualisieren' }).click()
    await reload
    await expect(anomalyCard(page, spike.name)).toBeVisible()
  })

  test('ZAE-AUF-04 Zähler aus einer Karte öffnen', async ({ page }) => {
    await openInbox(page)
    await anomalyCard(page, spike.name).locator('.card-meter').click()
    await expect(page).toHaveURL(new RegExp(`/zaehler/${spike.id}$`))
    await expect(pageTitle(page, spike.name)).toBeVisible()
  })

  test('ZAE-AUF-05 Auffälligkeit bestätigen', async ({ page }) => {
    await openInbox(page)
    await anomalyCard(page, spike.name).getByRole('button', { name: 'Bestätigen' }).click()
    await expect(anomalyCard(page, spike.name)).toHaveCount(0)

    await openInbox(page, '?scope=all')
    await expect(anomalyCard(page, spike.name)).toContainText('Bestätigt')
  })

  test('ZAE-AUF-08 Wieder öffnen', async ({ page }) => {
    await openInbox(page, '?scope=all')
    await anomalyCard(page, spike.name).getByRole('button', { name: 'Wieder öffnen' }).click()
    await expect(anomalyCard(page, spike.name)).toContainText('Offen')

    await openInbox(page)
    await expect(anomalyCard(page, spike.name)).toBeVisible()
  })

  test('ZAE-AUF-06 Auffälligkeit verwerfen', async ({ page }) => {
    await openInbox(page)
    await anomalyCard(page, standstill.name).getByRole('button', { name: 'Verwerfen' }).click()
    await expect(anomalyCard(page, standstill.name)).toHaveCount(0)

    await openInbox(page, '?scope=all')
    await expect(anomalyCard(page, standstill.name)).toContainText('Verworfen')
  })

  test('ZAE-AUF-07 Alle offenen verwerfen', async ({ page }) => {
    const other = await seedStandstill(uniqueName('E2E Auffällig anderer Typ'))
    await runAnomalyCheck()

    // Only what the filter shows is dismissed.
    await openInbox(page, '?type=consumption_spike')
    await expect(anomalyCard(page, spike.name)).toBeVisible()
    await page.getByRole('button', { name: 'Alle verwerfen' }).click()
    await expect(page.getByText('Keine offenen Auffälligkeiten')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Alle verwerfen' })).toHaveCount(0)

    await openInbox(page)
    await expect(anomalyCard(page, other.name)).toBeVisible()
    await expect(anomalyCard(page, spike.name)).toHaveCount(0)
  })
})
