/**
 * Where the user left the tax document list, so returning lands on it.
 *
 * Mirrors `documentListFocus` for the Steuer view, but with its own storage
 * key and its own anchor shape. Two reasons it cannot share the document list
 * anchor:
 *  - the same document can be filed under several tax sections, so the row is
 *    identified by section *and* document, not by document alone;
 *  - a single shared key would let an anchor dropped in one list steal the
 *    scroll position of the other one.
 */

const STORAGE_KEY = 'documents.taxListFocus'

export interface TaxListFocus {
  /** Slug of the tax section the row was rendered under. */
  section: string
  /** Document id of the row. */
  id: number
}

function isUsableId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0
}

/** Remember the row the user is navigating away from. */
export function rememberTaxListFocus(section: string, id: number): void {
  if (!section || !isUsableId(id)) return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ section, id }))
  } catch {
    /* private mode, quota — the scroll offset still gets us close */
  }
}

/**
 * Read the anchor and clear it — returning restores the position once, and a
 * later navigation into the list from elsewhere must start unanchored.
 */
export function consumeTaxListFocus(): TaxListFocus | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    sessionStorage.removeItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TaxListFocus>
    const id = Number(parsed?.id)
    if (typeof parsed?.section === 'string' && parsed.section && isUsableId(id)) {
      return { section: parsed.section, id }
    }
    return null
  } catch {
    return null
  }
}

/** The row's attribute value: unique per (section, document) pair. */
export function taxEntryKey(section: string, id: number): string {
  return `${section}:${id}`
}

/**
 * Scroll the anchored row into view and hand it keyboard focus, so a returning
 * user can carry on with the keyboard where they stopped. When the exact
 * section/document row is gone (filter changed, document re-classified) any
 * other row for the same document still counts as a hit — it is the same
 * document, just filed elsewhere. Returns null when neither is on screen and
 * the caller should fall back to the raw scroll offset.
 */
export function focusTaxListItem(root: ParentNode, focus: TaxListFocus): HTMLElement | null {
  const card =
    root.querySelector<HTMLElement>(`[data-tax-entry="${taxEntryKey(focus.section, focus.id)}"]`) ??
    root.querySelector<HTMLElement>(`[data-doc-id="${focus.id}"]`)
  if (!card) return null
  card.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  card.focus?.({ preventScroll: true })
  return card
}
