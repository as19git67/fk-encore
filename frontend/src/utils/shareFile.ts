/**
 * Saving a generated file (e.g. the recap MP4 export) to the device.
 *
 * On iOS Safari a plain `<a href>`/`window.location` navigation to an
 * `attachment` download is unreliable: the save/preview sheet flashes up and
 * is dismissed again, because the navigation happens outside a trusted user
 * gesture (the file only becomes available seconds later, after the async
 * render + poll). The robust path on iOS is the Web Share API with a File:
 * it opens the native share sheet ("Video sichern", "In Dateien sichern").
 *
 * Two rules make `navigator.share` work reliably:
 *  1. Feature-detect with `canShare({ files })` — desktop browsers and older
 *     Safari return false, so we fall back to a normal download link there.
 *  2. `share()` must be invoked synchronously inside the click handler with an
 *     already-fetched File. If we `await fetch()` first, iOS revokes the
 *     transient activation and rejects the share. Callers therefore fetch the
 *     File up front (once the export is ready) and only call `shareFile` on tap.
 */

/** True when the platform can share actual files (notably iOS Safari). */
export function canShareFiles(): boolean {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean
  }
  if (typeof nav.canShare !== 'function') return false
  try {
    const probe = new File([new Uint8Array()], 'probe.mp4', { type: 'video/mp4' })
    return nav.canShare({ files: [probe] })
  } catch {
    return false
  }
}

/** Fetch a URL into a File so it can be handed to the Web Share sheet. */
export async function fetchFileForSharing(
  url: string,
  filename: string,
): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  const blob = await res.blob()
  return new File([blob], filename, { type: blob.type || 'video/mp4' })
}

/** Programmatic download via a synthesized `<a download>` click (fallback). */
export function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Share the already-fetched `file` via the native sheet when possible, else
 * fall back to a download of `fallbackUrl`. Returns true when the share sheet
 * was used (including a user cancel), false when the download fallback ran.
 *
 * Must be called synchronously from a click handler — do not `await` anything
 * before this on iOS or the share is rejected.
 */
export async function shareFile(
  file: File,
  fallbackUrl: string,
): Promise<boolean> {
  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean
    share?: (data: { files?: File[]; title?: string }) => Promise<void>
  }
  if (nav.canShare?.({ files: [file] }) && typeof nav.share === 'function') {
    try {
      await nav.share({ files: [file], title: file.name })
    } catch (err) {
      // User cancelled — do not also trigger a download.
      if ((err as DOMException)?.name === 'AbortError') return true
      triggerDownload(fallbackUrl, file.name)
      return false
    }
    return true
  }
  triggerDownload(fallbackUrl, file.name)
  return false
}
