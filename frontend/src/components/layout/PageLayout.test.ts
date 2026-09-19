import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import PageLayout from './PageLayout.vue'
import { STACK_TARGET_ID, formatDocumentTitle } from './pageLayout'

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
