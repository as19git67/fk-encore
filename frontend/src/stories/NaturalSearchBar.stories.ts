import type { Meta, StoryObj } from '@storybook/vue3'
import NaturalSearchBar from '../components/NaturalSearchBar.vue'

const meta: Meta<typeof NaturalSearchBar> = {
  title: 'Components/NaturalSearchBar',
  component: NaturalSearchBar,
  args: {
    modelValue: '',
    loading: false,
    resultCount: null,
    hasParsedChips: false,
    locationChip: null,
    dateChip: null,
    semanticChip: null,
  },
}

export default meta
type Story = StoryObj<typeof NaturalSearchBar>

export const Leer: Story = {
  name: 'Leeres Suchfeld',
}

export const MitAnfrage: Story = {
  name: 'Mit Eingabe (ohne Ergebnis)',
  args: {
    modelValue: 'Kirchen in München von 2004 bis 2017',
  },
}

export const Sucht: Story = {
  name: 'Suche läuft',
  args: {
    modelValue: 'Strand Nordsee 2024',
    loading: true,
  },
}

export const MitErgebnissen: Story = {
  name: 'Ergebnisse + erkannte Filter (Chips)',
  args: {
    modelValue: 'Kirchen in München von 2004 bis 2017',
    resultCount: 42,
    hasParsedChips: true,
    semanticChip: 'Kirchen',
    locationChip: 'München',
    dateChip: '2004 – 2017',
  },
}

export const KeineTreffer: Story = {
  name: 'Keine Treffer',
  args: {
    modelValue: 'Elefanten im Schnee',
    resultCount: 0,
    hasParsedChips: true,
    semanticChip: 'Elefanten im Schnee',
    locationChip: null,
    dateChip: null,
  },
}
