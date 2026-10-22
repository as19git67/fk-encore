import type { Meta, StoryObj } from '@storybook/vue3'
import { defineComponent, h, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import App from '../App.vue'
import PageLayout from '../components/layout/PageLayout.vue'
import VirtualAlbumGrid from '../components/VirtualAlbumGrid.vue'
import type { Album } from '../api/photos'

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
