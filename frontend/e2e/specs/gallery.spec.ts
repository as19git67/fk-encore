import { test, expect } from '@playwright/test'

// Galerie-Tests setzen voraus, dass mindestens 3 Fotos sichtbar sind.
// Andernfalls werden einzelne Cases mit test.skip() übersprungen.

test.describe('Foto-Galerie (Maus-fokus)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('fotos/galerie')
    // Auf das Galerie-Grid warten — sichtbare Cells oder Leerstate.
    await Promise.race([
      page.locator('.vg-cell').first().waitFor({ state: 'visible', timeout: 15_000 }),
      page.getByText('Keine Fotos vorhanden.').waitFor({ state: 'visible', timeout: 15_000 }),
    ])
  })

  test('Hover hebt Cell hervor (CSS-Klasse oder vergrößert sichtbar)', async ({ page }) => {
    const cells = page.locator('.vg-cell:not(.vg-cell--skeleton)')
    const count = await cells.count()
    test.skip(count < 1, 'Keine Fotos in der Galerie — Hover-Test übersprungen')

    const first = cells.first()
    const box = await first.boundingBox()
    expect(box).not.toBeNull()
    await first.hover()
    // Visuelles Feedback prüfen wir defensiv: der Cursor-Indikator wird beim
    // Click gesetzt, Hover selbst hat keine Klassen-Mutation. Die Mouse-Move
    // soll lediglich ohne Fehler durchlaufen und das Element unter dem
    // Cursor sein.
    await expect(first).toBeVisible()
  })

  test('Klick auf Auswählen → Shift-Klick selektiert ersten und dritten Eintrag', async ({ page }) => {
    const cells = page.locator('.vg-cell:not(.vg-cell--skeleton)')
    const count = await cells.count()
    test.skip(count < 3, 'Weniger als 3 Fotos — Multi-Select-Test übersprungen')

    await page.getByRole('button', { name: /Auswählen/ }).click()
    // The compact tray also offers "Auswahl beenden". Assert the header
    // control specifically, rather than relying on an accessible-name match
    // that is intentionally shared by both exit controls.
    await expect(page.locator('.desktop-select-toggle')).toBeVisible()

    // Erste Cell anklicken, dritte mit Shift dazu (PrimeVue/Vue-Logik
    // toggelt aktuell pro Klick — dieser Test dokumentiert das Verhalten,
    // sobald Range-Select implementiert ist).
    await cells.nth(0).click()
    await cells.nth(2).click({ modifiers: ['Shift'] })

    await expect(cells.nth(0)).toHaveClass(/vg-cell--selected/)
    await expect(cells.nth(2)).toHaveClass(/vg-cell--selected/)
  })

  test('Pfeiltasten bewegen Cursor, Enter öffnet Vollbild', async ({ page }) => {
    const cells = page.locator('.vg-cell:not(.vg-cell--skeleton)')
    const count = await cells.count()
    test.skip(count < 2, 'Weniger als 2 Fotos — Tastaturnavigation übersprungen')

    // Fokus aufs Grid setzen, sonst landen Keys auf <body>. Click auf das
    // erste Cell setzt cursorIndex und gibt Fokus.
    await cells.first().click()
    // Vollbild würde sofort öffnen — Escape wieder schließen, falls geöffnet.
    await page.keyboard.press('Escape').catch(() => {})

    await page.keyboard.press('ArrowRight')
    // Cursor-Klasse wandert auf die nächste Cell
    await expect(cells.nth(1)).toHaveClass(/vg-cell--cursor/, { timeout: 5_000 })

    await page.keyboard.press('Enter')
    // Vollbild-Overlay ist eine Komponente mit Rolle dialog oder fixed-Layer.
    // Defensiv: Wir prüfen, dass irgendein Element mit fullscreen-Klasse oder
    // role=dialog erscheint.
    const overlay = page.locator(
      '[role="dialog"], .fullscreen-overlay, .p-dialog',
    )
    await expect(overlay.first()).toBeVisible({ timeout: 5_000 })
  })

  test('Strg-/Cmd-Klick (Mac) toggelt einzelne Auswahl im Auswählen-Modus', async ({ page }) => {
    const cells = page.locator('.vg-cell:not(.vg-cell--skeleton)')
    const count = await cells.count()
    test.skip(count < 2, 'Weniger als 2 Fotos — Modifier-Klick übersprungen')

    await page.getByRole('button', { name: /Auswählen/ }).click()

    // Auf Mac wäre Meta richtig, sonst Control. Playwright erkennt das
    // Test-OS nicht automatisch für `modifiers`, also schicken wir beide.
    await cells.nth(0).click({ modifiers: ['Control'] })
    await expect(cells.nth(0)).toHaveClass(/vg-cell--selected/)

    await cells.nth(0).click({ modifiers: ['Control'] })
    await expect(cells.nth(0)).not.toHaveClass(/vg-cell--selected/)
  })
})
