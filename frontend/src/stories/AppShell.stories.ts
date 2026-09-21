import type { Meta, StoryObj } from '@storybook/vue3'
import { defineComponent, h, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import App from '../App.vue'
import PageLayout from '../components/layout/PageLayout.vue'

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

function shellAt(path: string) {
  return () => ({
    components: { App },
    setup() {
      const router = useRouter()
      const demoPath = `${path}/story-demo`
      if (!router.hasRoute('story-demo-' + path)) {
        router.addRoute({ path: demoPath, name: 'story-demo-' + path, component: DemoPage })
      }
      onMounted(() => { void router.push(demoPath) })
      return () => h(App)
    },
  })
}

const meta: Meta = {
  title: 'Layout/AppShell',
  parameters: {
    // The navbar and the submenu strip both used to clip a focus ring —
    // the hamburger lost its left side, the submenu items their top and
    // bottom (issue #1281). Guarded here so they cannot lose it again.
    focusRingCheck: true,
  },
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
