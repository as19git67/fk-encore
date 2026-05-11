import { test, expect } from '@playwright/test'

// Login uses no shared storageState — it tests the form path itself.
test.use({ storageState: { cookies: [], origins: [] } })

const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com'
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'admin'

test.describe('Login (Tastatur-fokussiert)', () => {
  test('Tab-Reihenfolge: E-Mail → Passwort → Anmelden, Submit per Enter', async ({ page }) => {
    await page.goto('login')
    // PrimeVue Card title rendert nicht als role=heading. Submit-Button mit
    // exact:true ist ein verlässlicher Indikator, dass die Form da ist.
    await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible()

    const emailField = page.getByLabel('E-Mail')
    await emailField.click()
    await expect(emailField).toBeFocused()

    await page.keyboard.type(adminEmail, { delay: 20 })
    await page.keyboard.press('Tab')

    // InputText rendert direkt als <input id="password"> — der Toggle-Button
    // sitzt daneben in der DOM-Reihenfolge, der Fokus landet nach Tab erst hier.
    const passwordInput = page.locator('#password').first()
    await expect(passwordInput).toBeFocused()
    await page.keyboard.type(adminPassword, { delay: 20 })

    // Submit via Enter from inside the password field — exercises the
    // <form @submit.prevent> wiring without leaving the keyboard.
    await page.keyboard.press('Enter')

    await expect(page).toHaveURL(/\/fotos(\/|$)/)
    await expect(page.getByRole('button', { name: 'Hauptmenü' })).toBeVisible()
  })

  test('Falsches Passwort zeigt Fehlermeldung, fokussiert E-Mail wird nicht geleert', async ({ page }) => {
    await page.goto('login')

    await page.getByLabel('E-Mail').fill(adminEmail)
    await page.locator('#password').first().fill('definitely-wrong-pw')
    // exact:true disambiguates from "Mit Passkey anmelden"
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click()

    // PrimeVue Message renders with role=alert
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
    // Eingaben bleiben erhalten, damit Nutzer korrigieren statt neu tippen
    await expect(page.getByLabel('E-Mail')).toHaveValue(adminEmail)
  })

  test('Passwort-Toggle per Tastatur (Space auf Augen-Icon)', async ({ page }) => {
    await page.goto('login')

    const passwordInput = page.locator('#password').first()
    await passwordInput.fill('hunter2')
    await expect(passwordInput).toHaveAttribute('type', 'password')

    // Tab vom Input springt auf den Toggle-Button (echter <button>)
    await passwordInput.focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Passwort anzeigen' })).toBeFocused()
    await page.keyboard.press('Space')

    await expect(passwordInput).toHaveAttribute('type', 'text')
  })
})
