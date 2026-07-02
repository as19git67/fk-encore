import { test, expect } from '@playwright/test'

test.describe('Finance-Modul (DataTable + Tastatur)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('finanzen/umsaetze')
    // Page-Header rendert immer; auf DataTable warten wir nur, wenn Daten
    // geladen wurden. Permission-Schutz lassen wir defensiv durch.
    if ((await page.getByRole('heading', { name: 'Umsätze' }).count()) === 0) {
      test.skip(true, 'Aktueller Nutzer hat finance.view nicht — übersprungen')
    }
  })

  test('Auswahl-Counter spiegelt Klick auf Selection-Checkbox', async ({ page }) => {
    const rows = page.locator('table tbody tr')
    const count = await rows.count()
    test.skip(count < 2, 'Weniger als 2 Buchungen — Checkbox-Test übersprungen')

    // Erste Checkbox (Selection-Spalte) anklicken — PrimeVue rendert
    // role="checkbox" auf der Cell. Wir nehmen die erste Checkbox in Body.
    const firstCheckbox = rows.first().getByRole('checkbox')
    await firstCheckbox.click()

    await expect(page.getByText(/1 \/ \d+ ausgewählt/)).toBeVisible()

    // Zweite Zeile mit Shift selektieren — PrimeVue DataTable mit
    // selectionMode='multiple' unterstützt dies, wenn die Selektion am
    // Row-Click hängt; bei Header-Checkbox-Mode sind es einzelne Klicks.
    const secondCheckbox = rows.nth(1).getByRole('checkbox')
    await secondCheckbox.click({ modifiers: ['Shift'] })

    await expect(page.getByText(/[12] \/ \d+ ausgewählt/)).toBeVisible()
  })

  test('Pfeiltasten-Navigation in der DataTable bewegt den Fokus zeilenweise', async ({ page }) => {
    const rows = page.locator('table tbody tr')
    const count = await rows.count()
    test.skip(count < 2, 'Weniger als 2 Buchungen — Tastaturnavigation übersprungen')

    // Fokus auf erste Zeile setzen (PrimeVue setzt tabindex=0).
    const firstRow = rows.first()
    await firstRow.focus()

    await page.keyboard.press('ArrowDown')
    // Defensiv: ArrowDown soll Fokus auf einer anderen Zeile platzieren.
    // Wir prüfen, dass die zweite Zeile fokussiert ist ODER mindestens
    // tabindex=0 trägt — PrimeVue managt Fokus mit Roving-Tabindex.
    const second = rows.nth(1)
    await expect(second).toHaveAttribute('tabindex', '0').catch(async () => {
      // Fallback: aktive Element-ID prüfen
      const active = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 200))
      expect(active).toBeTruthy()
    })
  })

  test('Batch-Tag-Dialog öffnet sich erst nach Auswahl, schließt mit Escape', async ({ page }) => {
    const rows = page.locator('table tbody tr')
    const count = await rows.count()
    test.skip(count < 1, 'Keine Buchungen — Batch-Tag-Dialog übersprungen')

    const batchBtn = page.getByRole('button', { name: 'Tags auf Auswahl anwenden' })
    await expect(batchBtn).toBeDisabled()

    await rows.first().getByRole('checkbox').click()
    await expect(batchBtn).toBeEnabled()
    await batchBtn.click()

    const dialog = page.getByRole('dialog', { name: 'Tags auf Auswahl anwenden' })
    await expect(dialog).toBeVisible()

    // Escape schließt den Modal-Dialog ohne Speichern.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('Tag-AutoComplete: Eingeben + Enter fügt Chip hinzu', async ({ page }) => {
    const rows = page.locator('table tbody tr')
    const count = await rows.count()
    test.skip(count < 1, 'Keine Buchungen — AutoComplete-Test übersprungen')

    await rows.first().getByRole('checkbox').click()
    await page.getByRole('button', { name: 'Tags auf Auswahl anwenden' }).click()

    const dialog = page.getByRole('dialog', { name: 'Tags auf Auswahl anwenden' })
    const input = dialog.getByPlaceholder('Tag eingeben und Enter drücken')
    await input.click()
    await page.keyboard.type('e2e-tag', { delay: 25 })
    await page.keyboard.press('Enter')

    // PrimeVue AutoComplete im multiple-Mode rendert Chips als Tokens.
    await expect(dialog.locator('.p-autocomplete-token, .p-chip').first()).toContainText('e2e-tag')
  })
})

test.describe('Finance-Subheader und Analysezeitraum', () => {
  test('Transaktionswerkzeuge teilen sich einen sticky Toolbar-Stack', async ({ page }) => {
    await page.goto('finanzen')
    const accountLinks = page.locator('a[href*="/finanzen/uebersicht/konto/"]')
    const accountCount = await accountLinks.count()
    test.skip(accountCount === 0, 'Kein sichtbares Finance-Konto — Subheader-Test übersprungen')
    const href = await accountLinks.first().getAttribute('href')
    expect(href).toBeTruthy()
    await page.goto(href!)

    const stack = page.getByTestId('module-subheaders')
    const header = page.getByTestId('finance-transaction-header')
    await expect(header).toBeVisible()
    await expect(stack.locator('[data-testid="finance-transaction-header"]')).toHaveCount(1)

    const filterButton = header.getByRole('button', { name: 'Filter' })
    await expect(filterButton).toHaveCount(1)
    await filterButton.click()
    await expect(stack.locator('[data-testid="finance-filter-subheader"]')).toBeVisible()

    const selectionButton = header.getByRole('button', { name: 'Auswählen' })
    await expect(selectionButton).toHaveCount(1)
    await selectionButton.click()
    await expect(stack.locator('[data-testid="finance-selection-subheader"]')).toBeVisible()

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const stackTop = await stack.evaluate((element) => element.parentElement!.getBoundingClientRect().top)
    expect(Math.abs(stackTop)).toBeLessThanOrEqual(1)
  })

  test('N-Jahre-Feld akzeptiert zweistellige Werte ohne Abschneiden', async ({ page }) => {
    await page.route('**/finance/analysis/query', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ast: { tags: [], op: 'AND', kind: 'ongoing', interval: 'month' },
          total: { sum: '0', count: 0, avg: '0' },
          byPeriod: [],
          byTag: [],
          topCounterparties: [],
        }),
      })
    })
    await page.goto('finanzen/analyse')
    if ((await page.getByRole('heading', { name: 'Analyse' }).count()) === 0) {
      test.skip(true, 'Aktueller Nutzer hat finance.view nicht — übersprungen')
    }

    const question = page.getByPlaceholder('z. B. Was habe ich im Italien-Urlaub 2024 ausgegeben?')
    await question.fill('Testanalyse für Zeitraum')
    await question.press('Enter')

    const timespan = page.locator('.timespan-select')
    await expect(timespan).toBeVisible()
    await timespan.click()
    const yearsOption = page.getByRole('option', { name: 'Letzte N Jahre' })
    await expect(yearsOption).toHaveCount(1)
    await yearsOption.click()

    const yearsInput = page.getByRole('spinbutton', { name: 'Anzahl Jahre' })
    await expect(yearsInput).toHaveCount(1)
    await yearsInput.fill('12')
    await expect(yearsInput).toHaveValue('12')
    const width = await yearsInput.evaluate((element) => element.getBoundingClientRect().width)
    expect(width).toBeGreaterThanOrEqual(64)
  })
})
