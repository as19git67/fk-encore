/**
 * Whether the photo-detail panel may be edited.
 *
 * Editing is allowed only for the photo owner, and never while the panel is
 * read-only — which is the case while a fullscreen slideshow is running. As
 * soon as the slideshow is paused the panel becomes editable again.
 */
export function detailPanelEditable(isOwner: boolean, readOnly: boolean | undefined): boolean {
  return isOwner && !readOnly
}
