import { detectModule } from '../../config/modules'

/** Where PageLayout lifts its sticky part to; rendered once by App.vue. */
export const STACK_TARGET_ID = 'module-subheaders'

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

/** In the dev stack every title starts with this (see utils/devEnvironment.ts). */
export const DEV_TITLE_PREFIX = 'Dev'
let devTitle = false

/** Called once the app knows it runs in the dev stack. */
export function markDevTitle(on: boolean): void {
  devTitle = on
}

/**
 * "<Page> · <Module> · F4mil" — the module is derived from the route path.
 * In the dev stack "Dev · " goes in front, so a dev tab is never mistaken
 * for prod.
 */
export function formatDocumentTitle(page: string, modulePath: string | undefined): string {
  const mod = modulePath ? detectModule(modulePath) : null
  return [devTitle ? DEV_TITLE_PREFIX : null, page.trim(), mod?.label, APP_NAME]
    .filter((part): part is string => !!part)
    .join(' · ')
}
