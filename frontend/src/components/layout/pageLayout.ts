import type { InjectionKey, Ref } from 'vue'
import { detectModule } from '../../config/modules'

/** Where PageLayout lifts its sticky part to; rendered once by App.vue. */
export const STACK_TARGET_ID = 'module-subheaders'

/** The element whose scrollTop is the page's position (scroll="self"). */
export const PAGE_SCROLLER_KEY: InjectionKey<Ref<HTMLElement | null>> = Symbol('pageScroller')

export const APP_NAME = 'F4mil'

/** "<Page> · <Module> · F4mil" — the module is derived from the route path. */
export function formatDocumentTitle(page: string, modulePath: string | undefined): string {
  const mod = modulePath ? detectModule(modulePath) : null
  return [page.trim(), mod?.label, APP_NAME]
    .filter((part): part is string => !!part)
    .join(' · ')
}
