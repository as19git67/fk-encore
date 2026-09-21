import type { InjectionKey, Ref } from 'vue'
import { detectModule } from '../../config/modules'

/** Where PageLayout lifts its sticky part to; rendered once by App.vue. */
export const STACK_TARGET_ID = 'module-subheaders'

/** The element whose scrollTop is the page's position (scroll="self"). */
export const PAGE_SCROLLER_KEY: InjectionKey<Ref<HTMLElement | null>> = Symbol('pageScroller')

/**
 * What a view's `resolveAnchor` reports back to `PageLayout` (stage 4):
 *
 * - an element — the row is in the DOM; `PageLayout` scrolls it into view and
 *   focuses it,
 * - `true` — the view has already put the user back (a virtual grid scrolling
 *   by index does this itself),
 * - `false`, `null` or nothing — the row is gone or was never anchored, so the
 *   saved scroll offset is used instead.
 */
export type AnchorResolution = HTMLElement | boolean | null | void

export const APP_NAME = 'F4mil'

/** "<Page> · <Module> · F4mil" — the module is derived from the route path. */
export function formatDocumentTitle(page: string, modulePath: string | undefined): string {
  const mod = modulePath ? detectModule(modulePath) : null
  return [page.trim(), mod?.label, APP_NAME]
    .filter((part): part is string => !!part)
    .join(' · ')
}
