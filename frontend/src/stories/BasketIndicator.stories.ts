import type { Meta, StoryObj } from '@storybook/vue3'
import { h, ref } from 'vue'
import Button from 'primevue/button'
import BasketIndicator from '../components/BasketIndicator.vue'
import { defaultHandlers } from './handlers'

/**
 * The basket shell both modules use: the cart button with its badge, and the
 * drawer behind it. The rows and the footer actions come from the module, so
 * these stories supply stand-ins for them.
 */
const meta: Meta<typeof BasketIndicator> = {
  title: 'Components/BasketIndicator',
  component: BasketIndicator,
  parameters: {
    msw: { handlers: defaultHandlers },
  },
}

export default meta
type Story = StoryObj<typeof BasketIndicator>

interface Row {
  id: number
  title: string
  meta: string
}

const ROWS: Row[] = [
  { id: 1, title: 'Stromrechnung 2026', meta: 'Stadtwerke Musterstadt · 14.03.2026' },
  { id: 2, title: 'Versicherungspolice', meta: 'Beispiel Versicherung · 02.02.2026' },
  { id: 3, title: 'Kontoauszug März', meta: 'Beispielbank · 31.03.2026' },
]

function basket(options: { rows: Row[]; open?: boolean; info?: string; error?: string }) {
  return {
    components: { BasketIndicator },
    setup() {
      const shell = ref<InstanceType<typeof BasketIndicator> | null>(null)
      const rows = ref([...options.rows])
      // The drawer opens itself in the story, so the screenshot shows what
      // there is to look at rather than a closed button.
      const openWhenReady = (el: InstanceType<typeof BasketIndicator> | null) => {
        shell.value = el
        if (options.open !== false) queueMicrotask(() => el?.open())
      }

      return () =>
        h(
          'div',
          { style: 'padding:1rem;display:flex;justify-content:flex-end' },
          [
            h(
              BasketIndicator,
              {
                ref: openWhenReady as never,
                count: rows.value.length,
                singular: 'Dokument',
                plural: 'Dokumente',
                emptyHint:
                  'Lege Dokumente aus der Liste ab, um sie hier gemeinsam zu bearbeiten.',
                info: options.info ?? null,
                error: options.error ?? null,
              },
              {
                rows: () =>
                  rows.value.map((row) =>
                    h('li', { key: row.id, class: 'basket-row' }, [
                      h('button', { type: 'button', class: 'basket-row-body' }, [
                        h('div', { class: 'basket-row-title' }, row.title),
                        h('div', { class: 'basket-row-meta' }, [h('span', row.meta)]),
                      ]),
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'basket-row-remove',
                          'aria-label': `Aus Basket entfernen: ${row.title}`,
                          onClick: () => {
                            rows.value = rows.value.filter((r) => r.id !== row.id)
                          },
                        },
                        [h('i', { class: 'pi pi-times-circle' })],
                      ),
                    ]),
                  ),
                footer: () => [
                  h('div', { class: 'action-row' }, [
                    h(Button, { label: 'Tags', icon: 'pi pi-tag', size: 'small' }),
                    h(Button, { label: 'Kategorie', icon: 'pi pi-folder', size: 'small' }),
                  ]),
                  h('div', { style: 'display:flex;justify-content:flex-end' }, [
                    h(Button, {
                      label: 'Alles leeren',
                      icon: 'pi pi-times',
                      size: 'small',
                      text: true,
                      severity: 'secondary',
                      onClick: () => {
                        rows.value = []
                      },
                    }),
                  ]),
                ],
              },
            ),
          ],
        )
    },
  }
}

export const MitEintraegen: Story = {
  name: 'Mit Einträgen',
  render: () => basket({ rows: ROWS }),
}

export const Leer: Story = {
  name: 'Leer',
  render: () => basket({ rows: [] }),
}

export const MitMeldung: Story = {
  name: 'Nach einer Aktion',
  render: () => basket({ rows: ROWS, info: '3 Dokumente verschlagwortet.' }),
}

export const NurDerKnopf: Story = {
  name: 'Nur der Knopf (Badge)',
  render: () => basket({ rows: ROWS, open: false }),
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: () => basket({ rows: ROWS }),
}
