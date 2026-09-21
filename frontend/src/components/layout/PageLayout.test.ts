import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import PageLayout from './PageLayout.vue'
import { STACK_TARGET_ID, formatDocumentTitle } from './pageLayout'
import { saveListAnchor, takeListAnchor } from '../../utils/listAnchor'
import type { ListAnchor } from '../../utils/listAnchor'
import { markNavigation, saveScrollOffset, setPageScroller } from '../../utils/scrollMemory'

/**
 * The page skeleton's two contracts with the app shell: the sticky part
 * lands in `#module-subheaders` when the shell provides it and inline when
 * it does not (Storybook, tests), and the document title always names page,
 * module and app in that order.
 */

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/dokumente', component: { render: () => null } },
      { path: '/finanzen/konto/1', component: { render: () => null } },
    ],
  })
}

let apps: App[] = []
let host: HTMLElement

async function mountPage(router: Router, props: Record<string, unknown>, slots: Record<string, () => unknown> = {}) {
  const Comp = defineComponent({
    setup: () => () => h(PageLayout, props, slots),
  })
  const app = createApp(Comp)
  app.use(router)
  await router.isReady()
  const el = document.createElement('div')
  host.appendChild(el)
  app.mount(el)
  apps.push(app)
  await nextTick()
  return el
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  sessionStorage.clear()
  setPageScroller(null)
  markNavigation(false)
})

afterEach(() => {
  for (const app of apps) app.unmount()
  apps = []
  host.remove()
  document.getElementById(STACK_TARGET_ID)?.remove()
})

describe('formatDocumentTitle', () => {
  it('names page, module and app', () => {
    expect(formatDocumentTitle('Dokumente', '/dokumente')).toBe('Dokumente · Dokumente · F4mil')
    expect(formatDocumentTitle('Girokonto', '/finanzen/konto/1')).toBe('Girokonto · Finanzen · F4mil')
  })

  it('drops the module outside any module route', () => {
    expect(formatDocumentTitle('Profil', '/profile')).toBe('Profil · F4mil')
    expect(formatDocumentTitle('  Login ', undefined)).toBe('Login · F4mil')
  })
})

describe('PageLayout', () => {
  it('renders one <h1> from the title and writes document.title', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const el = await mountPage(router, { title: 'Dokumente', hint: 'Alle Belege' })
    const headings = el.querySelectorAll('h1')
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent).toBe('Dokumente')
    expect(el.querySelector('.page-hint')?.textContent).toBe('Alle Belege')
    expect(document.title).toBe('Dokumente · Dokumente · F4mil')
  })

  it('renders the toolbar inline when the app shell is absent', async () => {
    const router = makeRouter()
    await router.push('/')
    const el = await mountPage(router, { title: 'Seite' }, {
      toolbar: () => h('input', { placeholder: 'Suche' }),
    })
    expect(el.querySelector('.page-toolbar input')).not.toBeNull()
    expect(el.querySelector('.page-stack--inline')).not.toBeNull()
  })

  it('lifts toolbar, selection and notice into the app stack when present', async () => {
    const stack = document.createElement('div')
    stack.id = STACK_TARGET_ID
    document.body.appendChild(stack)

    const router = makeRouter()
    await router.push('/dokumente')
    const el = await mountPage(router, { title: 'Dokumente' }, {
      toolbar: () => h('span', { class: 'probe-toolbar' }),
      selection: () => h('span', { class: 'probe-selection' }),
      notice: () => h('span', { class: 'probe-notice' }),
      default: () => h('p', 'Inhalt'),
    })
    expect(el.querySelector('.probe-toolbar')).toBeNull()
    expect(stack.querySelector('.page-toolbar .probe-toolbar')).not.toBeNull()
    expect(stack.querySelector('.page-selection .probe-selection')).not.toBeNull()
    expect(stack.querySelector('.page-notice .probe-notice')).not.toBeNull()
    // The content and the title stay on the page.
    expect(el.querySelector('.page-content p')?.textContent).toBe('Inhalt')
    expect(stack.querySelector('h1')).toBeNull()
  })

  it('exposes scroll mode, width and readiness as classes and data', async () => {
    const router = makeRouter()
    await router.push('/')
    const el = await mountPage(router, { title: 'Galerie', scroll: 'self', width: 'full', ready: false })
    const page = el.querySelector('.page')!
    expect(page.classList.contains('page--scroll-self')).toBe(true)
    expect(page.classList.contains('page--width-full')).toBe(true)
    expect(page.getAttribute('data-page-ready')).toBe('false')
  })
})

/**
 * Coming back from a detail page (issue #1272, stage 4). The row wins over
 * the offset, the offset only counts when the user actually came back, and a
 * page that is not ready yet is not scrolled at all — its list is still two
 * rows tall.
 */
describe('PageLayout restore', () => {
  /** jsdom lays nothing out, so record what the page asked for instead. */
  function spyOnScrolling() {
    const scrollIntoView = vi.fn()
    const focus = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView
    HTMLElement.prototype.focus = focus as unknown as typeof HTMLElement.prototype.focus
    const scrollTo = vi.fn()
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo
    return { scrollIntoView, focus, scrollTo }
  }

  function rowSlot(anchor: string) {
    return {
      default: () => h('div', { 'data-anchor': anchor, class: 'row' }, 'Zeile'),
    }
  }

  it('scrolls the anchored row into view and focuses it', async () => {
    const spies = spyOnScrolling()
    const router = makeRouter()
    await router.push('/dokumente')
    saveListAnchor('dokumente', { kind: 'document', id: 7 })

    await mountPage(router, { title: 'Dokumente', anchorKey: 'dokumente' }, rowSlot('document:7'))
    await nextTick()
    await nextTick()

    expect(spies.scrollIntoView).toHaveBeenCalled()
    expect(spies.focus).toHaveBeenCalled()
    // Used up: entering the list again from a menu starts unanchored.
    expect(takeListAnchor('dokumente')).toBeNull()
  })

  it('waits for the page to be ready before it restores anything', async () => {
    const spies = spyOnScrolling()
    const router = makeRouter()
    await router.push('/dokumente')
    saveListAnchor('dokumente', { kind: 'document', id: 7 })

    const seen: Array<ListAnchor | null> = []
    const el = await mountPage(
      router,
      {
        title: 'Dokumente',
        anchorKey: 'dokumente',
        ready: false,
        resolveAnchor: (anchor: ListAnchor | null) => {
          seen.push(anchor)
          return true
        },
      },
      rowSlot('document:7'),
    )
    await nextTick()
    expect(seen).toEqual([])
    expect(spies.scrollIntoView).not.toHaveBeenCalled()
    expect(el.querySelector('.page')?.getAttribute('data-page-ready')).toBe('false')
  })

  it('lets a virtual list place itself and then stays out of the way', async () => {
    const spies = spyOnScrolling()
    const router = makeRouter()
    await router.push('/dokumente')
    saveListAnchor('fotos-alben', { kind: 'album', id: 3 })
    saveScrollOffset('/dokumente', 900)
    markNavigation(true)

    const seen: Array<ListAnchor | null> = []
    await mountPage(router, {
      title: 'Alben',
      anchorKey: 'fotos-alben',
      resolveAnchor: (anchor: ListAnchor | null) => {
        seen.push(anchor)
        return true
      },
    })
    await nextTick()
    await nextTick()

    expect(seen).toEqual([{ kind: 'album', id: 3 }])
    // The grid reported it had scrolled, so the offset must not fight it.
    expect(spies.scrollTo).not.toHaveBeenCalled()
  })

  it('falls back to the offset when the row is gone, but only on the way back', async () => {
    const spies = spyOnScrolling()
    const router = makeRouter()
    await router.push('/dokumente')
    saveScrollOffset('/dokumente', 900)

    // Picked from a menu: a fresh start at the top.
    markNavigation(false)
    await mountPage(router, { title: 'Dokumente', anchorKey: 'dokumente' })
    await nextTick()
    await nextTick()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(spies.scrollTo).not.toHaveBeenCalled()

    // Came back through history: put the page where it was.
    markNavigation(true)
    await mountPage(router, { title: 'Dokumente', anchorKey: 'dokumente' })
    await nextTick()
    await nextTick()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(spies.scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'instant' })
  })
})
