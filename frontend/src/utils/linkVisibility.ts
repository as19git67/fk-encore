/**
 * The per-photo public-link setting as the UI works with it.
 *
 * The stored value is a tri-state ('auto' | 'visible' | 'hidden'), but what a
 * user reasons about is the effective one: does a link visitor see this photo?
 * The default 'auto' withholds photos with a known face on them, so the same
 * raw value can mean either. Every surface that offers the toggle — the detail
 * sidebar and the fullscreen toolbar — shares these helpers so they cannot
 * drift apart.
 */

import { isVisibleViaLink, type Photo, type PhotoLinkVisibility } from '../api/photos'

type LinkVisibilityPhoto = Pick<Photo, 'link_visibility' | 'has_known_face'>

export { isVisibleViaLink }

/**
 * What one click on the toggle should store.
 *
 * Releasing a withheld photo is always an explicit 'visible'. Taking a shown
 * photo back out returns it to the default when the default already withholds
 * it (a known face is on it), and is an explicit 'hidden' otherwise — so the
 * stored value stays the weakest one that produces what the user asked for.
 */
export function nextLinkVisibility(photo: LinkVisibilityPhoto): PhotoLinkVisibility {
  if (!isVisibleViaLink(photo)) return 'visible'
  return photo.has_known_face ? 'auto' : 'hidden'
}

/** Icon class for the toggle and for the album-grid marker. */
export function linkVisibilityIcon(photo: LinkVisibilityPhoto): string {
  return isVisibleViaLink(photo) ? 'pi pi-link' : 'pi pi-link-slash'
}

/** Tooltip naming both the current state and what the click will do. */
export function linkVisibilityTooltip(photo: LinkVisibilityPhoto): string {
  const visibility = photo.link_visibility ?? 'auto'
  if (isVisibleViaLink(photo)) {
    return visibility === 'visible' && photo.has_known_face
      ? 'Trotz bekanntem Gesicht über Freigabe-Links sichtbar — wieder ausnehmen'
      : 'Über Freigabe-Links sichtbar — ausnehmen'
  }
  return photo.has_known_face && visibility === 'auto'
    ? 'Bekanntes Gesicht erkannt: über Freigabe-Links nicht sichtbar — trotzdem freigeben'
    : 'Über Freigabe-Links nicht sichtbar — freigeben'
}
