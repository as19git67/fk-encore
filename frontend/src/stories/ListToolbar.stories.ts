import type { Meta, StoryObj } from '@storybook/vue3'
import { computed, ref } from 'vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import type { FilterChip, ListToolbarModel } from '../components/layout/listToolbar'

/**
 * The one toolbar every list view uses (issue #1272, stage 3): search,
 * filter with chips, sort, view switcher, select mode — always in the same
 * order, with the result count on the second row.
 */
const meta: Meta<typeof ListToolbar> = {
  title: 'Layout/ListToolbar',
  component: ListToolbar,
}

export default meta
type Story = StoryObj<typeof ListToolbar>

const SORT_FIELDS = [
  { value: 'uploaded_at', label: 'Hochgeladen' },
  { value: 'doc_date', label: 'Dokumentdatum' },
  { value: 'title', label: 'Titel' },
]

interface ModelOptions {
  chips?: string[]
  loaded?: number
  total?: number | undefined
  loading?: boolean
  withView?: boolean
  withSelection?: boolean
  term?: string
  /** A filter panel that stays open, so the button reads as pressed. */
  filterOpen?: boolean
}

function makeModel(options: ModelOptions = {}): ListToolbarModel {
  const chipLabels = ref(options.chips ?? [])
  const applied = ref({ field: 'uploaded_at', direction: 'desc' as const })

  const chips = computed<FilterChip[]>(() =>
    chipLabels.value.map((label) => ({
      key: label,
      label,
      remove: () => {
        chipLabels.value = chipLabels.value.filter((l) => l !== label)
      },
    })),
  )

  return {
    search: { value: ref(options.term ?? ''), placeholder: 'Suche in Dokumenten…' },
    filter: {
      chips,
      activeCount: computed(() => chipLabels.value.length),
      open: () => { /* the view opens its own filter menu */ },
      expanded: options.filterOpen ? ref(true) : undefined,
      clearAll: () => { chipLabels.value = [] },
    },
    sort: {
      fields: SORT_FIELDS,
      applied,
      draft: ref({ ...applied.value }),
      isDefault: computed(() => true),
      fieldLabel: computed(
        () => SORT_FIELDS.find((f) => f.value === applied.value.field)?.label ?? '',
      ),
      openEdit: () => {},
      apply: () => {},
      reset: () => {},
      select: (field: string) => { applied.value = { ...applied.value, field } },
    },
    view: options.withView
      ? {
          options: [
            { value: 'list', label: 'Liste', icon: 'pi pi-list' },
            { value: 'grid', label: 'Kacheln', icon: 'pi pi-th-large' },
          ],
          value: ref('list'),
        }
      : undefined,
    selection: options.withSelection
      ? { active: ref(false), toggle: () => {} }
      : undefined,
    result: {
      loaded: computed(() => options.loaded ?? 0),
      total: computed(() => options.total),
      loading: computed(() => options.loading ?? false),
    },
  }
}

const render = (options: ModelOptions) => () => ({
  components: { ListToolbar },
  setup: () => ({ model: makeModel(options) }),
  template: '<ListToolbar :model="model" />',
})

export const Standard: Story = {
  name: 'Ohne Filter',
  render: render({ loaded: 42, total: 42, withView: true, withSelection: true }),
}

export const Gefiltert: Story = {
  name: 'Mit aktiven Filtern',
  render: render({
    chips: ['Kategorie: Rechnungen', 'Tag: Strom', 'Datum: 2024-01-01 – 2024-12-31'],
    loaded: 200,
    total: 4567,
    term: 'strom',
    withView: true,
    withSelection: true,
  }),
}

export const Laedt: Story = {
  name: 'Während des Ladens',
  render: render({ chips: ['Kategorie: Rechnungen'], loaded: 0, loading: true }),
}

export const OhneTreffer: Story = {
  name: 'Ohne Treffer',
  render: render({ chips: ['Tag: Unbekannt'], loaded: 0, total: 0, term: 'xyz' }),
}

export const FilterOffen: Story = {
  name: 'Filterpanel offen',
  render: render({
    chips: ['Tag: Strom'],
    loaded: 200,
    total: 4567,
    filterOpen: true,
    withSelection: true,
  }),
}

export const Schmal: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
  render: render({
    chips: ['Kategorie: Rechnungen', 'Tag: Strom'],
    loaded: 200,
    total: 4567,
    withView: true,
    withSelection: true,
  }),
}
