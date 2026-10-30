/**
 * Share an internal link to a detail page with another user of the app.
 *
 * The link is the app's own URL: it opens the web app (or the iOS app, where
 * universal links are configured) and navigates to the entity. Nothing is
 * made public — the recipient signs in and only sees the entity when the
 * existing access rules let them.
 *
 * On devices with a native share sheet (iOS/Android) the URL goes to the
 * sheet, so it can be handed straight to a messenger. Everywhere else it is
 * copied to the clipboard, and `copied` flips to true for two seconds so the
 * button can show a check mark instead of needing a toast.
 */
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import type { ToolbarItem } from '../components/ResponsiveToolbar.vue'
import { canShareFiles } from '../utils/shareFile'

export function useShareLink() {
  const router = useRouter()
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  function markCopied() {
    copied.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      copied.value = false
    }, 2000)
  }

  async function copyToClipboard(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      markCopied()
    } catch {
      // Clipboard API unavailable (insecure context, permissions). Fall back
      // to the legacy path so the button never silently does nothing.
      const area = document.createElement('textarea')
      area.value = url
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try {
        if (document.execCommand('copy')) markCopied()
      } finally {
        area.remove()
      }
    }
  }

  /** Share (mobile) or copy (desktop) the absolute URL of an in-app route. */
  async function shareLink(to: RouteLocationRaw, title?: string): Promise<void> {
    const url = new URL(router.resolve(to).href, window.location.origin).toString()
    // `canShareFiles` is the same "there is a real share sheet" heuristic the
    // photo share uses: true on iOS/Android, false on desktop browsers, where
    // the clipboard is what people expect from a link button.
    if (canShareFiles() && typeof navigator.share === 'function') {
      try {
        await navigator.share({ url, title })
        return
      } catch (err) {
        // Cancelled by the user — nothing more to do.
        if ((err as DOMException)?.name === 'AbortError') return
        // Sheet failed for another reason: the clipboard still works.
      }
    }
    await copyToClipboard(url)
  }

  /**
   * The "Link teilen" entry for a `ResponsiveToolbar`. Call inside a
   * `computed` so the check-mark feedback after copying is reactive.
   */
  function shareLinkItem(to: RouteLocationRaw, title?: string): ToolbarItem {
    return {
      key: 'share-link',
      title: copied.value ? 'Link kopiert' : 'Link teilen',
      icon: copied.value ? 'pi pi-check' : 'pi pi-link',
      text: true,
      severity: 'secondary',
      menuOnly: true,
      command: () => void shareLink(to, title),
    }
  }

  return { copied, shareLink, shareLinkItem }
}
