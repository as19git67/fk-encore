/**
 * Album names are unique per owner, ignoring case and surrounding spaces —
 * the server refuses a second one with `already_exists` (photo.service.ts,
 * findAlbumByName). These helpers let a dialog say so before posting.
 */

export interface NamedAlbum {
  id: number
  name: string
  my_access_level?: string
}

export function albumNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** The caller's own album called `name`, other than `exceptId`. */
export function findOwnAlbumByName<T extends NamedAlbum>(
  albums: readonly T[],
  name: string,
  exceptId?: number,
): T | undefined {
  const key = albumNameKey(name)
  if (!key) return undefined
  return albums.find((a) => a.id !== exceptId && a.my_access_level === 'owner' && albumNameKey(a.name) === key)
}
