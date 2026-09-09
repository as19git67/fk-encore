/**
 * Where the user left the document list, so returning lands on it.
 *
 * A scroll offset alone is not enough: the list reloads on the way back, and a
 * row that grew a chip or lost a tag shifts everything below it. The anchor is
 * therefore the row itself — the browser scrolls it into view, and the raw
 * offset in useScrollRestore stays as the fallback for when the row is gone
 * (deleted, filtered away, on a page not loaded yet).
 *
 * The list holds two kinds of row — documents and Sammelmappen — but the user
 * left from exactly one of them, so they share a single key. Two keys would
 * mean a stale document anchor and a fresh folder anchor competing on the way
 * back, and whichever won would be the wrong one.
 */

const STORAGE_KEY = 'documents.listFocus'
/** Pre-kind key: a plain document id. Read once so an open tab survives the change. */
const LEGACY_KEY = 'documents.listFocusId'

export type DocumentListFocusKind = 'document' | 'collection'

export interface DocumentListFocus {
  kind: DocumentListFocusKind
  id: number
}

function isUsableId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0
}

/** Remember the row the user is navigating away from. */
export function rememberListFocus(kind: DocumentListFocusKind, id: number): void {
  if (!isUsableId(id)) return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ kind, id }))
  } catch {
    /* private mode, quota — the scroll offset still gets us close */
  }
}

/** Remember an opened document. Thin wrapper kept for the common case. */
export function rememberDocumentListFocus(id: number): void {
  rememberListFocus('document', id)
}

/** Remember an opened Sammelmappe. */
export function rememberCollectionListFocus(id: number): void {
  rememberListFocus('collection', id)
}

/**
 * Read the anchor and clear it — returning restores the position once, and a
 * later navigation into the list from elsewhere must start unanchored.
 */
export function consumeListFocus(): DocumentListFocus | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    sessionStorage.removeItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DocumentListFocus>
      const id = Number(parsed?.id)
      if ((parsed?.kind === 'document' || parsed?.kind === 'collection') && isUsableId(id)) {
        return { kind: parsed.kind, id }
      }
      return null
    }
    const legacy = sessionStorage.getItem(LEGACY_KEY)
    sessionStorage.removeItem(LEGACY_KEY)
    const legacyId = Number(legacy)
    return isUsableId(legacyId) ? { kind: 'document', id: legacyId } : null
  } catch {
    return null
  }
}

/** The document-only reading of the anchor, for callers that only handle documents. */
export function consumeDocumentListFocus(): number | null {
  const focus = consumeListFocus()
  return focus?.kind === 'document' ? focus.id : null
}

/** The row's attribute selector — documents and folders are marked separately. */
function selectorFor(focus: DocumentListFocus): string {
  return focus.kind === 'collection'
    ? `[data-collection-id="${focus.id}"]`
    : `[data-doc-id="${focus.id}"]`
}

/**
 * Scroll the anchored row into view and hand it keyboard focus, so a returning
 * user can carry on with the keyboard where they stopped. Returns the row, or
 * null when it is not on screen — the caller then falls back to the offset.
 */
export function focusListItem(root: ParentNode, focus: DocumentListFocus): HTMLElement | null {
  const card = root.querySelector<HTMLElement>(selectorFor(focus))
  if (!card) return null
  card.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  const focusTarget = card.matches('[tabindex]')
    ? card
    : card.querySelector<HTMLElement>('.document-title, .collection-row') ?? card
  focusTarget?.focus?.({ preventScroll: true })
  return card
}

/** Document-only wrapper, kept because most callers only ever pass a document. */
export function focusDocumentListItem(root: ParentNode, id: number): HTMLElement | null {
  return focusListItem(root, { kind: 'document', id })
}
