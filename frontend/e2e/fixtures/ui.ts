import { expect, type Locator, type Page } from '@playwright/test'

// Small helpers for the PrimeVue forms the module specs drive. The app wraps
// each control in its `<label>`, so a field is found by the label's leading
// text and the control inside it.

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The `<label>` whose text starts with `text` (the control's own text follows it). */
export function field(scope: Page | Locator, text: string): Locator {
  return scope.locator('label').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}`) }).first()
}

/** Types into a PrimeVue InputText inside the labelled field. */
export async function fillText(scope: Page | Locator, label: string, value: string): Promise<void> {
  await field(scope, label).locator('input, textarea').first().fill(value)
}

/**
 * Types a number into a PrimeVue InputNumber. Its own key handling formats as
 * it goes, so `fill()` would bypass it; select what is there and type instead.
 */
export async function fillNumber(scope: Page | Locator, label: string, value: number): Promise<void> {
  const input = field(scope, label).locator('input').first()
  await typeNumber(input, value)
}

export async function typeNumber(input: Locator, value: number): Promise<void> {
  await input.click()
  await input.press('ControlOrMeta+a')
  await input.press('Backspace')
  await input.pressSequentially(String(value).replace('.', ','))
  await input.blur()
}

/** Opens the PrimeVue Select inside the labelled field and picks an option. */
export async function choose(page: Page, scope: Page | Locator, label: string, option: string): Promise<void> {
  await field(scope, label).locator('.p-select').click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** Confirms the PrimeVue ConfirmDialog with the given header. */
export async function confirm(page: Page, header: string, acceptLabel: string): Promise<void> {
  const dialog = page.getByRole('alertdialog', { name: header })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: acceptLabel, exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** The `<h1>` of the page (PageLayout renders the title as the only one). */
export function pageTitle(page: Page, title: string): Locator {
  return page.getByRole('heading', { level: 1, name: title, exact: true })
}

/** Formats like the app does for a meter value (`de-DE`, fixed decimals). */
export function fmtValue(value: number, decimals = 0): string {
  return value.toLocaleString('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
