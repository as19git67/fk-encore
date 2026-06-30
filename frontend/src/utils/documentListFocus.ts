const STORAGE_KEY = 'documents.listFocusId'

export function rememberDocumentListFocus(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) return
  try { sessionStorage.setItem(STORAGE_KEY, String(id)) } catch { /* ignore */ }
}

export function consumeDocumentListFocus(): number | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    sessionStorage.removeItem(STORAGE_KEY)
    const id = Number(raw)
    return Number.isSafeInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function focusDocumentListItem(root: ParentNode, id: number): HTMLElement | null {
  const card = root.querySelector<HTMLElement>(`[data-doc-id="${id}"]`)
  if (!card) return null
  card.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  const focusTarget = card.matches('[tabindex]')
    ? card
    : card.querySelector<HTMLElement>('.document-title')
  focusTarget?.focus({ preventScroll: true })
  return card
}
