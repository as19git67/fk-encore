import { test as base, expect, type Page } from '@playwright/test'

// Helpers shared across specs. Kept tiny on purpose — Playwright's
// built-in locators (getByRole, getByLabel) cover most of what Track M
// needs; this only abstracts what would otherwise be repeated boilerplate.

export const test = base.extend<{
  // Re-export `expect` via the fixture so individual specs only import
  // from one place.
  page: Page
}>({})

export { expect }

/** Ensure the SPA is loaded and the auth store has rehydrated from localStorage. */
export async function gotoApp(page: Page, path = '/fotos/galerie') {
  await page.goto(path)
  // The navbar only renders when `auth.isAuthenticated`, so waiting for
  // the hamburger button is a reliable proxy for "rehydrated session".
  await expect(page.getByRole('button', { name: 'Hauptmenü' })).toBeVisible()
}

/** Tap a key sequence with realistic per-key delay (closer to real users). */
export async function typeRealistic(page: Page, text: string, delayMs = 30) {
  await page.keyboard.type(text, { delay: delayMs })
}

/** Click while holding a modifier — wraps the keyboard.down/up boilerplate. */
export async function clickWith(
  page: Page,
  selector: string | { hover: () => Promise<void>; click: (opts?: any) => Promise<void> },
  modifiers: Array<'Shift' | 'Control' | 'Meta' | 'Alt'>,
) {
  const target =
    typeof selector === 'string' ? page.locator(selector).first() : selector
  await (target as any).click({ modifiers })
}
