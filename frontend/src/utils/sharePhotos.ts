/**
 * Share one or more library photos via the Web Share API.
 *
 * Mirrors the collage share flow (see CollageDialog.vue): the selected photos
 * are fetched as files and handed to `navigator.share({ files })`, with a
 * download fallback where file sharing is unavailable (most desktop browsers).
 *
 * The `/photos/file/*` endpoint is public (`auth: false`), so the originals
 * can be fetched by URL without auth headers. HEIC/HEIF originals are served
 * as JPEG via `?convert=true` for non-Safari user agents, matching the same
 * UA-detection used elsewhere in the app.
 */
import { getPhotoUrl, getPhotoDetailsBatch } from '../api/photos'

function isHeic(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.heic') || lower.endsWith('.heif')
}

function isSafari(): boolean {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
}

function withConvert(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}convert=true`
}

async function fetchPhotoFile(filename: string, originalName: string): Promise<File> {
  const base = getPhotoUrl(filename)
  // Safari decodes HEIC natively; everyone else needs the server-side JPEG.
  const wantConvert = isHeic(filename) && !isSafari()
  let resp = await fetch(wantConvert ? withConvert(base) : base)
  // Cover UA-detection blind spots: retry once with conversion on failure.
  if (!resp.ok && isHeic(filename) && !wantConvert) {
    resp = await fetch(withConvert(base))
  }
  if (!resp.ok) {
    throw new Error(`Foto konnte nicht geladen werden: ${originalName || filename}`)
  }
  const blob = await resp.blob()
  let name = originalName || filename
  // A converted HEIC arrives as JPEG — fix the extension so the share target
  // and any download see a correct, openable file name.
  if (wantConvert || isHeic(name)) {
    name = name.replace(/\.(heic|heif)$/i, '.jpg')
  }
  return new File([blob], name, { type: blob.type || 'image/jpeg' })
}

export interface SharePhotosResult {
  /** True when the native Web Share sheet was used. */
  shared: boolean
  /** True when we fell back to downloading the file(s). */
  downloaded: boolean
}

/**
 * Fetch the given photos and share (or download) them. Resolves with what
 * happened; a user-cancelled share sheet resolves with both flags false.
 * Throws on a genuine failure (network / decode error) for the caller to
 * surface.
 */
export async function sharePhotos(photoIds: number[]): Promise<SharePhotosResult> {
  if (photoIds.length === 0) return { shared: false, downloaded: false }

  const { photos } = await getPhotoDetailsBatch(photoIds)
  const byId = new Map(photos.map((p) => [p.id, p]))
  // Preserve the selection order; drop any id the server didn't return.
  const ordered = photoIds
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)

  const files = await Promise.all(
    ordered.map((p) => fetchPhotoFile(p.filename, p.original_name)),
  )
  if (files.length === 0) return { shared: false, downloaded: false }

  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean
  }
  if (nav.share && nav.canShare?.({ files })) {
    try {
      await nav.share({ files, title: files.length === 1 ? 'Foto' : 'Fotos' })
      return { shared: true, downloaded: false }
    } catch (err) {
      // User cancelled the share sheet — not an error worth surfacing.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { shared: false, downloaded: false }
      }
      throw err
    }
  }

  // No Web Share API (or no file sharing) → download the file(s).
  for (const file of files) {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    URL.revokeObjectURL(url)
  }
  return { shared: false, downloaded: true }
}
