import type { Meta, StoryObj } from '@storybook/vue3'
import { h } from 'vue'
import Button from 'primevue/button'
import SelectionBar from '../components/layout/SelectionBar.vue'
import PageLayout from '../components/layout/PageLayout.vue'
import { useListSelection } from '../composables/useListSelection'
import type { ToolbarItem } from '../components/ResponsiveToolbar.vue'
import { defaultHandlers } from './handlers'

/**
 * The bar every list shows while rows are picked. It lives in `PageLayout`'s
 * `selection` slot, so these stories render it there rather than on its own:
 * how it sits in the page is half of what there is to look at.
 */
const meta: Meta<typeof SelectionBar> = {
  title: 'Layout/SelectionBar',
  component: SelectionBar,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof SelectionBar>

const ROWS = Array.from({ length: 24 }, (_, i) => i + 1)

const ACTIONS: ToolbarItem[] = [
  { key: 'tag', label: 'Verschlagworten', title: 'Verschlagworten', icon: 'pi pi-tag', command: () => {} },
  { key: 'share', label: 'Teilen', title: 'Teilen', icon: 'pi pi-share-alt', command: () => {} },
  { key: 'download', title: 'Herunterladen', icon: 'pi pi-download', text: true, command: () => {} },
  { key: 'delete', label: 'Löschen', title: 'Löschen', icon: 'pi pi-trash', severity: 'danger', command: () => {} },
]

function page(setup: {
  picked?: number[]
  total?: number
  actions?: ToolbarItem[]
  noun?: string
  hint?: string
  primary?: boolean
}) {
  return {
    components: { PageLayout, SelectionBar },
    setup() {
      const selection = useListSelection({
        loadedIds: () => ROWS,
        total: () => setup.total ?? ROWS.length,
        fetchAllIds: async () => Array.from({ length: setup.total ?? ROWS.length }, (_, i) => i + 1),
        hotkeys: false,
      })
      selection.enter()
      for (const id of setup.picked ?? []) selection.toggleId(id, true)

      return () =>
        h(
          PageLayout,
          { title: 'Fotos', scroll: 'page', width: 'full' },
          {
            selection: () =>
              h(
                SelectionBar,
                {
                  selection,
                  actions: setup.actions ?? [],
                  noun: setup.noun,
                  hint: setup.hint,
                },
                {
                  primary: setup.primary
                    ? () => h(Button, { label: 'In den Basket', icon: 'pi pi-shopping-cart', size: 'small' })
                    : undefined,
                },
              ),
            default: () =>
              h(
                'div',
                { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px' },
                ROWS.map((id) =>
                  h(
                    'div',
                    {
                      key: id,
                      style:
                        'aspect-ratio:1;border-radius:6px;background:var(--p-content-hover-background);display:flex;align-items:center;justify-content:center;color:var(--p-text-muted-color)',
                    },
                    String(id),
                  ),
                ),
              ),
          },
        )
    },
  }
}

export const NichtsGewaehlt: Story = {
  name: 'Auswahlmodus, nichts gewählt',
  render: () => page({ picked: [], actions: ACTIONS, noun: 'Fotos' }),
}

export const EinigeGewaehlt: Story = {
  name: 'Einige gewählt',
  render: () => page({ picked: [1, 2, 3], actions: ACTIONS, noun: 'Fotos', primary: true }),
}

export const AllesGewaehlt: Story = {
  name: 'Alles gewählt',
  render: () => page({ picked: ROWS, actions: ACTIONS, noun: 'Fotos' }),
}

export const MitHinweis: Story = {
  name: 'Mit Hinweis (Umschalt+Klick)',
  render: () =>
    page({
      picked: [4],
      actions: ACTIONS,
      noun: 'Fotos',
      hint: 'Umschalt+Klick wählt den Bereich',
    }),
}

export const Telefon: Story = {
  name: 'Telefonbreite (am unteren Rand)',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: () => page({ picked: [1, 2], actions: ACTIONS, noun: 'Fotos', primary: true }),
}
