/**
 * Printing a PDF from the app.
 *
 * Desktop browsers (Chrome, Edge, Firefox, Safari on the Mac) print a PDF
 * that sits in an iframe of the page: the PDF is loaded from a blob URL into
 * an iframe out of sight and its window's `print()` opens the browser's own
 * print dialog with the PDF, not the app page.
 *
 * iPhone and iPad do not: there `print()` in the iframe prints the page
 * around it, or nothing. The reliable way is the share sheet with the PDF as
 * a file, which offers "Drucken" (AirPrint). `navigator.share` has to be
 * called straight from a tap with the file already fetched (see
 * `utils/shareFile.ts`), so callers fetch first and ask for a second tap.
 */

/** iPhone, iPad and iPod — iPadOS reports itself as a Mac with touch. */
export function isIosLike(nav: Navigator = navigator): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1
}

/** How long the iframe stays after the dialog opened, for slow print previews. */
const CLEANUP_MS = 10 * 60 * 1000

let current: { frame: HTMLIFrameElement; url: string; timer: ReturnType<typeof setTimeout> } | null = null

function cleanup(): void {
  if (!current) return
  clearTimeout(current.timer)
  current.frame.remove()
  URL.revokeObjectURL(current.url)
  current = null
}

/**
 * Open the browser's print dialog for `pdf`. Resolves once the dialog was
 * asked for. The iframe outlives the call, because removing it while the
 * dialog is open cancels the print in some browsers; it goes with the next
 * print or after ten minutes.
 */
export function printPdfBlob(pdf: Blob): Promise<void> {
  cleanup()
  // A blob without a type would not open in the frame's PDF viewer; an image
  // scan keeps its own type and prints as the image.
  const url = URL.createObjectURL(pdf.type ? pdf : new Blob([pdf], { type: 'application/pdf' }))
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.title = 'Druckvorschau'
  // Not display:none — Chrome does not print a frame that is not rendered.
  Object.assign(frame.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  })
  current = { frame, url, timer: setTimeout(cleanup, CLEANUP_MS) }

  return new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => {
      // The PDF viewer inside the frame needs a moment after `load` before
      // it prints the document rather than a blank page.
      setTimeout(() => {
        try {
          const win = frame.contentWindow
          if (!win) throw new Error('Druckfenster nicht verfügbar')
          win.focus()
          win.print()
          resolve()
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }, 100)
    }, { once: true })
    frame.src = url
    document.body.appendChild(frame)
  })
}
