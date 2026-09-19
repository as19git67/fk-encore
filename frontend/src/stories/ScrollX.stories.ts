import type { Meta, StoryObj } from '@storybook/vue3'
import ScrollX from '../components/layout/ScrollX.vue'

/**
 * The wrapper wide content scrolls in (issue #1272, stage 1): the page never
 * scrolls sideways, a table or strip wider than the screen does so in here.
 */
const meta: Meta<typeof ScrollX> = {
  title: 'Layout/ScrollX',
  component: ScrollX,
}

export default meta
type Story = StoryObj<typeof ScrollX>

const strip = `
  <ScrollX>
    <div style="display:flex; gap:8px; padding:8px 0">
      <div v-for="n in 20" :key="n"
        style="flex:0 0 160px; height:100px; border-radius:8px; display:flex; align-items:center; justify-content:center; background: var(--p-content-hover-background); border:1px solid var(--p-content-border-color)">
        Kachel {{ n }}
      </div>
    </div>
  </ScrollX>
`

export const Kachelstreifen: Story = {
  render: () => ({ components: { ScrollX }, template: strip }),
}

export const Schmal: Story = {
  name: 'Telefonbreite (Kantenschatten rechts)',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: () => ({ components: { ScrollX }, template: strip }),
}

export const PasstHinein: Story = {
  name: 'Inhalt passt (keine Schatten)',
  render: () => ({
    components: { ScrollX },
    template: `<ScrollX><div style="padding:8px">Kurzer Inhalt, nichts zu scrollen.</div></ScrollX>`,
  }),
}
