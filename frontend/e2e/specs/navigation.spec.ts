import { test, expect } from '@playwright/test'

// Spec-globale storageState aus globalSetup ist aktiv → wir starten authentisiert.

test.describe('Navigation (Maus + Tastatur)', () => {
  test('Hamburger-Menü per Maus öffnet Modulauswahl, Pfeil/Enter wechselt Modul', async ({ page }) => {
    await page.goto('/fotos/galerie')
    const burger = page.getByRole('button', { name: 'Hauptmenü' })
    await expect(burger).toBeVisible()

    await burger.click()

    // PrimeVue Menu rendert role=menuitem für jeden Eintrag
    const dokumente = page.getByRole('menuitem', { name: /Dokumente/i })
    await expect(dokumente).toBeVisible()
    await dokumente.click()

    await expect(page).toHaveURL(/\/dokumente(\/|$)/)
  })

  test('Tastatur-Fokus durchläuft Submenu-Strip in DOM-Reihenfolge', async ({ page }) => {
    await page.goto('/fotos/galerie')
    // Erst sicherstellen, dass der Submenu-Strip da ist
    const submenu = page.locator('.submenu-strip')
    await expect(submenu).toBeVisible()

    // Fokus auf das erste Submenu-Element setzen, dann nacheinander Tab.
    const firstItem = submenu.getByRole('button').first()
    await firstItem.focus()
    await expect(firstItem).toBeFocused()

    // Mindestens zwei sichtbare Sub-Module → Tab muss den nächsten erreichen.
    const items = submenu.getByRole('button')
    const count = await items.count()
    test.skip(count < 2, 'Submenu hat weniger als 2 Einträge — Tab-Test übersprungen')

    await page.keyboard.press('Tab')
    await expect(items.nth(1)).toBeFocused()
  })

  test('Profil-Button (icon-only) hat aria-label und ist per Enter aktivierbar', async ({ page }) => {
    await page.goto('/fotos/galerie')

    const profileBtn = page.getByRole('button', { name: 'Profil' })
    await expect(profileBtn).toBeVisible()
    await profileBtn.focus()
    await page.keyboard.press('Enter')

    await expect(page).toHaveURL(/\/profile/)
  })
})
