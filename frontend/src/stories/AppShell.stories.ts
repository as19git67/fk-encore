import type { Meta, StoryObj } from '@storybook/vue3'
import { defineComponent, h, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import App from '../App.vue'
import PageLayout from '../components/layout/PageLayout.vue'
import VirtualAlbumGrid from '../components/VirtualAlbumGrid.vue'
import GalleryView from '../views/GalleryView.vue'
import type { Album } from '../api/photos'
import type { GalleryGridEntry } from '../api/gallery'
import { http, HttpResponse } from 'msw'
import { defaultHandlers } from './handlers'

/**
 * The application shell (issue #1272, stage 1): the sticky stack of navbar,
 * the active module's sub-menu row and whatever the page lifts up through
 * PageLayout, with the content scrolling underneath.
 *
 * The story registers a demo route inside the module so the router-view has
 * something to show; the stub router in preview.ts renders nothing for the
 * real routes.
 */

const DemoPage = defineComponent({
  name: 'DemoPage',
  components: { PageLayout, Button, InputText },
  template: `
    <PageLayout title="Beispielseite" hint="Eine Seite im Modul, mit Toolbar im Sticky-Stack." width="normal">
      <template #actions>
        <Button label="Neu" icon="pi pi-plus" />
      </template>
      <template #toolbar>
        <div style="display:flex; gap:8px; align-items:center">
          <InputText placeholder="Suche…" style="flex:1 1 200px; min-width:0" />
          <Button icon="pi pi-filter" text rounded aria-label="Filter" severity="secondary" />
        </div>
      </template>
      <p v-for="n in 30" :key="n">Absatz {{ n }}: Inhalt, der unter dem Stack hindurchscrollt.</p>
    </PageLayout>
  `,
})

// A detail page (issue #1674): the title row with the way back sits in the
// sticky stack and stays put while the long content scrolls.
const DemoDetail = defineComponent({
  name: 'DemoDetail',
  components: { PageLayout, Button },
  template: `
    <PageLayout title="Beispielbuchung" hint="Girokonto" width="normal" sticky-header>
      <template #actions>
        <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" />
        <Button label="Bearbeiten" icon="pi pi-pencil" severity="secondary" outlined />
      </template>
      <p v-for="n in 40" :key="n">Zeile {{ n }}: Angaben zur Buchung.</p>
    </PageLayout>
  `,
})

const demoAlbums: Album[] = Array.from({ length: 120 }, (_, i) => ({
  id: i + 1,
  name: `Album ${i + 1}`,
  description: null,
  photo_count: (i * 7) % 40,
  cover_filename: null,
}) as unknown as Album)

// A virtual grid that scrolls with the document, with a pinned column beside
// it (`.page-aside`) — the gallery's layout without its data.
const DemoGrid = defineComponent({
  name: 'DemoGrid',
  components: { PageLayout, InputText, VirtualAlbumGrid },
  setup: () => ({ albums: demoAlbums }),
  template: `
    <PageLayout title="Alben" width="full">
      <template #toolbar>
        <InputText placeholder="Suche…" style="width:100%" />
      </template>
      <div style="display:flex">
        <div style="flex:1; min-width:0">
          <VirtualAlbumGrid :albums="albums" />
        </div>
        <aside class="page-aside" style="width:240px; flex-shrink:0; border-left:1px solid var(--p-content-border-color); padding:8px">
          <p v-for="n in 60" :key="n" style="margin:0 0 8px">Detail {{ n }}</p>
        </aside>
      </div>
    </PageLayout>
  `,
})

function shellAt(path: string, page = DemoPage) {
  return () => ({
    components: { App },
    setup() {
      const router = useRouter()
      const name = `story-demo-${path}-${page.name ?? 'page'}`
      const demoPath = `${path}/${name.replace(/[^a-z0-9-]/gi, '-')}`
      if (!router.hasRoute(name)) {
        router.addRoute({ path: demoPath, name, component: page })
      }
      onMounted(() => { void router.push(demoPath) })
      return () => h(App)
    },
  })
}

const meta: Meta = {
  title: 'Layout/AppShell',
}

export default meta
type Story = StoryObj

export const Dokumente: Story = {
  name: 'Modul Dokumente',
  render: shellAt('/dokumente'),
}

export const Finanzen: Story = {
  name: 'Modul Finanzen',
  render: shellAt('/finanzen'),
}

export const Telefon: Story = {
  name: 'Telefonbreite (Untermenü scrollt in sich)',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: shellAt('/fotos'),
}

export const Detailseite: Story = {
  name: 'Detailseite: Zurück bleibt im Sticky-Stack',
  render: shellAt('/finanzen', DemoDetail),
}

export const DetailseiteTelefon: Story = {
  name: 'Detailseite auf Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: shellAt('/finanzen', DemoDetail),
}

export const Raster: Story = {
  name: 'Virtuelles Raster scrollt mit dem Dokument',
  render: shellAt('/fotos', DemoGrid),
}

// Polls until `read` returns something, the way the other stories wait for
// the app to settle.
async function waitFor<T>(read: () => T | null | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

function stackTop(): number {
  return document.querySelector('.app-toolbar-stack')?.getBoundingClientRect().top ?? NaN
}

// A menu that opens from the stack while the page is scrolled: PrimeVue puts
// it right under its button and focuses it, and the focus must not scroll
// the page (it did, by the stack's height, while <html> carried the stack as
// `scroll-padding-top`).
export const MenueGescrollt: Story = {
  name: 'Hauptmenü öffnet am Knopf, auch weiter unten auf der Seite',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: shellAt('/finanzen', DemoDetail),
  play: async () => {
    const button = await waitFor(
      () => document.querySelector<HTMLButtonElement>('.sticky-navbar button'),
      'the menu button',
    )
    await waitFor(() => (document.documentElement.scrollHeight > window.innerHeight + 400 ? true : null), 'a long page')
    window.scrollTo({ top: 400, behavior: 'instant' })
    await settle()
    button.click()
    const menu = await waitFor(() => document.querySelector<HTMLElement>('.p-menu-overlay'), 'the menu')
    await settle()
    if (window.scrollY !== 400) throw new Error(`opening the menu scrolled the page to ${window.scrollY}`)
    const gap = menu.getBoundingClientRect().top - button.getBoundingClientRect().bottom
    if (Math.abs(gap) > 8) throw new Error(`the menu opens ${gap}px away from its button`)
    button.click()
  },
}

// The real gallery in the shell, with a library long enough that jumping to
// the other end scrolls a long way (and short enough for the runner's
// full-page screenshot).
const LIBRARY = 300
function libraryEntry(index: number): GalleryGridEntry {
  return { id: index + 1, filename: `foto-${index + 1}.jpg`, curation: 'visible', orientation: null }
}
const idsHandler = http.get('/api/gallery/ids', () =>
  HttpResponse.json({ ids: Array.from({ length: LIBRARY }, (_, i) => i + 1) }),
)
const libraryHandler = http.get('/api/gallery/grid', ({ request }) => {
  const params = new URL(request.url).searchParams
  const limit = Number(params.get('limit') ?? 200)
  const offsetParam = params.get('offset')
  const offset = offsetParam === null ? Math.max(0, LIBRARY - limit) : Number(offsetParam)
  const end = Math.min(LIBRARY, offset + limit)
  const photos = Array.from({ length: Math.max(0, end - offset) }, (_, i) => libraryEntry(offset + i))
  return HttpResponse.json({ total: LIBRARY, offset, photos })
})

export const Galerie: Story = {
  name: 'Galerie: scrollt im eigenen Kasten, Sprung ans Ende lässt den Stack stehen',
  parameters: {
    testViewport: { width: 390, height: 844 },
    msw: {
      handlers: [
        libraryHandler,
        idsHandler,
        http.get('/api/photos/:id/ocr', () => HttpResponse.json({ ocr: null })),
        http.get('/api/photos/uploaders', () => HttpResponse.json({ uploaders: [] })),
        ...defaultHandlers,
      ],
    },
  },
  render: () => ({
    components: { App },
    setup() {
      const router = useRouter()
      const name = 'story-gallery'
      if (!router.hasRoute(name)) router.addRoute({ path: '/fotos/story-galerie', name, component: GalleryView })
      onMounted(() => { void router.push('/fotos/story-galerie') })
      return () => h(App)
    },
  }),
  play: async () => {
    await waitFor(() => document.querySelector('.vg-cell'), 'the grid')
    const jump = (label: string) => waitFor(
      // On a phone the jump is an icon; its name is the aria-label.
      () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((b) => b.textContent?.includes(label) || b.getAttribute('aria-label') === label),
      `the button "${label}"`,
    )
    // The grid scrolls in its own box, the document not at all: a document
    // millions of pixels tall crashed Safari on a jump to the other end.
    const grid = document.querySelector<HTMLElement>('.virtual-gallery')!
    // The grid lands on the newest photo; to the oldest and back again.
    ;(await jump('Zum ältesten')).click()
    await settle()
    if (grid.scrollTop > 200) throw new Error(`the jump to the oldest stopped at ${grid.scrollTop}`)
    ;(await jump('Zum neuesten')).click()
    await settle()
    const end = grid.scrollHeight - grid.clientHeight
    if (end < 1000) throw new Error(`the grid does not scroll in its own box (${end}px to scroll)`)
    if (end - grid.scrollTop > 200) throw new Error(`the jump to the newest stopped at ${grid.scrollTop} of ${end}`)
    const pageEnd = document.documentElement.scrollHeight - window.innerHeight
    if (pageEnd > 1) throw new Error(`the document scrolls as well (${pageEnd}px)`)
    if (stackTop() !== 0) throw new Error(`the sticky stack left the screen after the jump (top ${stackTop()})`)

    // Scrolling away by hand stays where it went: nothing steers back to the
    // photo the jump aimed at.
    grid.scrollTo({ top: 0, behavior: 'instant' })
    await settle()
    if (grid.scrollTop !== 0) throw new Error(`the grid scrolled back to ${grid.scrollTop} after the user left`)
  },
}
