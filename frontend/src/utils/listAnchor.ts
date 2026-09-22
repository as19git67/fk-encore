/**
 * Where the user left a list, so coming back lands on it.
 *
 * A scroll offset alone is not enough: the list reloads on the way back, and a
 * row that grew a chip or lost a tag shifts everything below it. The anchor is
 * therefore the row itself — it gets scrolled into view and focused, and the
 * raw offset (`scrollMemory`) stays as the fallback for when the row is gone:
 * deleted, filtered away, or on a page that is not loaded yet.
 *
 * One anchor per list, keyed by route name. A list holding more than one kind
 * of row — documents and Sammelmappen, say — still stores one anchor, because
 * the user left from exactly one row; two keys would mean a stale anchor and a
 * fresh one competing on the way back, and whichever won would be the wrong
 * one.
 *
 * Generalised from `documentListFocus.ts` (issue #1272, stage 4).
 */

const PREFIX = 'list_anchor:'
/** The documents list' own key from before this module existed. Read once. */
const LEGACY_DOCUMENTS_KEY = 'documents.listFocus'
/** Pre-kind documents key: a plain id. Read once as well. */
const LEGACY_DOCUMENTS_ID_KEY = 'documents.listFocusId'

/**
 * The row to return to. `kind` separates the row types a single list shows
 * (`document` and `collection` in the document list, `transaction` in the
 * account, …) and picks the marker attribute the row carries.
 */
export interface ListAnchor {
  kind: string
  id: number
}

function isUsableId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0
}

function isUsableKind(kind: unknown): kind is string {
  return typeof kind === 'string' && kind.length > 0 && !kind.includes(':')
}

/** The value a row carries in `data-anchor`; `anchorSelector` looks for it. */
export function anchorKey(kind: string, id: number): string {
  return `${kind}:${id}`
}

export function anchorSelector(anchor: ListAnchor): string {
  return `[data-anchor="${anchorKey(anchor.kind, anchor.id)}"]`
}

/**
 * Remember the row the user is opening. Call it right before navigating to
 * the detail, with the list's own route name as the key.
 */
export function saveListAnchor(routeKey: string, anchor: ListAnchor): void {
  if (!isUsableId(anchor.id) || !isUsableKind(anchor.kind)) return
  try {
    sessionStorage.setItem(PREFIX + routeKey, JSON.stringify(anchor))
  } catch {
    /* private mode, quota — the scroll offset still gets us close */
  }
}

function parseAnchor(raw: string | null): ListAnchor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ListAnchor>
    const id = Number(parsed?.id)
    return isUsableKind(parsed?.kind) && isUsableId(id) ? { kind: parsed.kind, id } : null
  } catch {
    return null
  }
}

function takeLegacyDocumentsAnchor(): ListAnchor | null {
  const stored = parseAnchor(sessionStorage.getItem(LEGACY_DOCUMENTS_KEY))
  sessionStorage.removeItem(LEGACY_DOCUMENTS_KEY)
  if (stored) return stored
  const legacyId = Number(sessionStorage.getItem(LEGACY_DOCUMENTS_ID_KEY))
  sessionStorage.removeItem(LEGACY_DOCUMENTS_ID_KEY)
  return isUsableId(legacyId) ? { kind: 'document', id: legacyId } : null
}

/**
 * Read the anchor and clear it: returning restores the position once, and
 * entering the list again from elsewhere has to start unanchored.
 *
 * `legacyKey` names a key an older build wrote, so a tab that navigated away
 * before the update still lands right when it comes back.
 */
export function takeListAnchor(routeKey: string, legacyKey?: 'documents'): ListAnchor | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + routeKey)
    sessionStorage.removeItem(PREFIX + routeKey)
    const parsed = parseAnchor(raw)
    if (parsed) return parsed
    return legacyKey === 'documents' ? takeLegacyDocumentsAnchor() : null
  } catch {
    return null
  }
}

/**
 * Forget the anchor without using it (the list was entered from a menu).
 *
 * Takes the same `legacyKey` as `takeListAnchor`, so a tab that was upgraded
 * mid-session drops the old build's keys here too — otherwise they would sit
 * and wait to anchor a visit that never asked for it.
 */
export function clearListAnchor(routeKey: string, legacyKey?: 'documents'): void {
  try {
    sessionStorage.removeItem(PREFIX + routeKey)
    if (legacyKey === 'documents') {
      sessionStorage.removeItem(LEGACY_DOCUMENTS_KEY)
      sessionStorage.removeItem(LEGACY_DOCUMENTS_ID_KEY)
    }
  } catch {
    /* nothing stored, nothing to lose */
  }
}

/**
 * Scroll the anchored row into view and hand it keyboard focus, so a
 * returning user carries on with the keyboard where they stopped. Returns the
 * row, or null when it is not in the DOM — the caller then falls back to the
 * offset.
 *
 * The row itself takes focus when it can (`tabindex`, a button); otherwise the
 * first focusable element inside it does, which is what a row that wraps its
 * title in a button needs.
 */
export function focusListAnchor(root: ParentNode, anchor: ListAnchor): HTMLElement | null {
  const row = root.querySelector<HTMLElement>(anchorSelector(anchor))
  if (!row) return null
  row.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  const target = row.matches('[tabindex], a[href], button, input, select, textarea')
    ? row
    : row.querySelector<HTMLElement>('[tabindex], a[href], button') ?? row
  target?.focus?.({ preventScroll: true })
  return row
}
