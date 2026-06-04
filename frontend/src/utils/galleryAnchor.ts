/**
 * Resolve a photo's index inside a virtualized gallery, re-anchoring the
 * window on it when the initial page didn't include it.
 *
 * Why this exists: the gallery centers its first page on `aroundPhotoId`, but
 * that prop can race the component's mount. When it does, the backend returns
 * the newest page instead and the target photo sits outside the loaded window,
 * so a plain `findLoadedIndexById` misses it and the photo the user was just
 * looking at (e.g. after switching from an album or fullscreen into the
 * gallery) ends up not selected. Reloading anchored on the target recovers the
 * correct page. AlbumDetailView already does this; the gallery did not, which
 * is the regression this guards against.
 *
 * Returns the resolved index, or null when the photo is genuinely absent from
 * the current filter/scope (filtered out, or owned by another user).
 */
export interface ReanchorableGallery {
  findLoadedIndexById: (id: number) => number | null
  reload: (opts: { aroundPhotoId: number }) => Promise<void>
}

export async function findOrReanchorIndex(
  gallery: ReanchorableGallery,
  targetId: number,
): Promise<number | null> {
  const direct = gallery.findLoadedIndexById(targetId)
  if (direct !== null) return direct
  // Target wasn't in the initial window — re-anchor on it and try once more.
  await gallery.reload({ aroundPhotoId: targetId })
  return gallery.findLoadedIndexById(targetId)
}
