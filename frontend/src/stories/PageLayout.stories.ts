import type { Meta, StoryObj } from '@storybook/vue3'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import PageLayout from '../components/layout/PageLayout.vue'
import ScrollX from '../components/layout/ScrollX.vue'

/**
 * The page skeleton every view fills (issue #1272, stage 1). Outside the app
 * shell there is no sticky stack, so the toolbar renders inline above the
 * title; in the app it is lifted into the stack under the sub-menu row.
 */
const meta: Meta<typeof PageLayout> = {
  title: 'Layout/PageLayout',
  component: PageLayout,
  argTypes: {
    scroll: { control: 'radio', options: ['page', 'self'] },
    width: { control: 'radio', options: ['normal', 'wide', 'full'] },
  },
}

export default meta
type Story = StoryObj<typeof PageLayout>

const paragraphs = Array.from({ length: 12 }, (_, i) =>
  `Absatz ${i + 1}: Beispieltext, der die Seite füllt, damit das Scrollverhalten sichtbar wird.`,
)

function render(args: Record<string, unknown>, extra = '') {
  return () => ({
    components: { PageLayout, Button, InputText, Message, ScrollX },
    setup: () => ({ args, paragraphs }),
    template: `
      <PageLayout v-bind="args">
        <template #actions>
          <Button icon="pi pi-question-circle" text rounded aria-label="Hilfe" />
          <Button label="Neu" icon="pi pi-plus" />
        </template>
        ${extra}
        <p v-for="p in paragraphs" :key="p">{{ p }}</p>
      </PageLayout>
    `,
  })
}

const TOOLBAR = `
  <template #toolbar>
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
      <InputText placeholder="Suche…" style="flex:1 1 200px; min-width:0" />
      <Button icon="pi pi-filter" text rounded aria-label="Filter" severity="secondary" />
      <Button icon="pi pi-sort-amount-down" text rounded aria-label="Sortierung" severity="secondary" />
    </div>
  </template>
`

export const NurTitel: Story = {
  name: 'Nur Titel und Aktionen',
  args: { title: 'Beispielseite', hint: 'Eine Zeile Erklärung unter dem Titel.' },
  render: render({ title: 'Beispielseite', hint: 'Eine Zeile Erklärung unter dem Titel.' }),
}

export const MitToolbar: Story = {
  name: 'Mit Toolbar und Hinweis',
  render: render(
    { title: 'Liste', width: 'wide' },
    TOOLBAR + `
    <template #notice>
      <Message severity="info" :closable="false">Ein Hinweis unter der Toolbar.</Message>
    </template>`,
  ),
}

export const EigenerScroller: Story = {
  name: 'scroll="self" (Inhalt scrollt selbst)',
  render: render({ title: 'Galerie', scroll: 'self', width: 'full' }, TOOLBAR),
}

export const VolleBreite: Story = {
  name: 'width="full" mit breiter Tabelle in ScrollX',
  render: render(
    { title: 'Tabelle', width: 'full' },
    `
    <ScrollX>
      <table style="border-collapse:collapse; min-width:1100px">
        <thead><tr>
          <th v-for="n in 12" :key="n" style="padding:8px; border:1px solid var(--p-content-border-color); text-align:left">Spalte {{ n }}</th>
        </tr></thead>
        <tbody><tr v-for="r in 3" :key="r">
          <td v-for="n in 12" :key="n" style="padding:8px; border:1px solid var(--p-content-border-color)">Zelle {{ r }}.{{ n }}</td>
        </tr></tbody>
      </table>
    </ScrollX>`,
  ),
}

export const Schmal: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: render({ title: 'Ein längerer Seitentitel, der umbricht' }, TOOLBAR),
}
