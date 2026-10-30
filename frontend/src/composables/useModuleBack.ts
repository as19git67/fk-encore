import { useRouter } from 'vue-router'
import { markNextNavigationAsReturn } from '../utils/scrollMemory'

export function isPathInsideModule(path: string | null | undefined, basePath: string): boolean {
  if (!path) return false
  return path === basePath || path.startsWith(`${basePath}/`) || path.startsWith(`${basePath}?`)
}

/**
 * Pages that open objects of every module and expect the reader back: the
 * assistant's answers (a document, a booking, a photo out of a chat) and the
 * mixed Sammelmappen, and Finanzen › Steuer, which lists the documents of a
 * tax year. Coming from one of them, "Zurück" is the history, not
 * the module's list — the reader was in the middle of a conversation, and
 * `PageLayout` puts them back on the row they opened.
 */
const CROSS_MODULE_ORIGINS = ['/assistent', '/sammelmappen', '/finanzen/steuer']

/** Whether the previous entry is one of the pages that open objects across modules. */
export function isCrossModuleOrigin(path: string | null | undefined): boolean {
  return CROSS_MODULE_ORIGINS.some((origin) => isPathInsideModule(path, origin))
}

/** Whether "Zurück" from a page of `basePath` may be plain history for this previous entry. */
export function isReturnableOrigin(path: string | null | undefined, basePath: string): boolean {
  return isPathInsideModule(path, basePath) || isCrossModuleOrigin(path)
}

/**
 * Returns a goBack function that stays within the given module basePath.
 * Uses browser history if the previous entry belongs to the same module or
 * to a page that opens objects across modules (the assistant, the
 * Sammelmappen); otherwise navigates to the specified fallback route.
 */
export function useModuleBack(basePath: string, fallbackRouteName: string) {
  const router = useRouter()

  function goBack() {
    const back = window.history.state?.back as string | undefined
    if (isReturnableOrigin(back, basePath)) {
      router.back()
    } else {
      // No in-module history (the detail was opened from a shared link): the
      // push to the list is still a return, so the list restores the anchor
      // the detail page saved instead of starting at the top.
      markNextNavigationAsReturn()
      void router.push({ name: fallbackRouteName })
    }
  }

  return { goBack }
}
