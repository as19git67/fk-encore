import type { Meta, StoryObj } from '@storybook/vue3'
import { ref } from 'vue'
import MarkdownEditor from '../components/documents/MarkdownEditor.vue'
import MarkdownView from '../components/documents/MarkdownView.vue'

const SAMPLE = `# Heizungswartung

Termin mit dem **Kundendienst** am *Dienstag*, Kosten siehe [Angebot](https://beispiel.test/angebot).

## Zu erledigen

- [x] Filter bestellen
- [ ] Druck prüfen
- Notizen
  - Ventil links klemmt

1. Wasser ablassen
2. Filter tauschen

> Hinweis: vorher den Strom abschalten.

\`\`\`
Fehlercode E-42
\`\`\`

| Teil | Menge | Preis |
| --- | :-: | --: |
| Filter | 2 | 18,00 € |
| Dichtung | 1 | 4,50 € |

---

<b>HTML wird als Text gezeigt</b>
`

const meta: Meta<typeof MarkdownEditor> = {
  title: 'Documents/MarkdownEditor',
  component: MarkdownEditor,
}

export default meta
type Story = StoryObj<typeof MarkdownEditor>

export const MitText: Story = {
  name: 'Editor mit Vorschau',
  render: () => ({
    components: { MarkdownEditor },
    setup() {
      const text = ref(SAMPLE)
      return { text }
    },
    template: '<div style="padding: 16px; display: flex; flex-direction: column; min-height: 600px"><MarkdownEditor v-model="text" /></div>',
  }),
}

export const Leer: Story = {
  name: 'Leerer Editor',
  render: () => ({
    components: { MarkdownEditor },
    setup() {
      const text = ref('')
      return { text }
    },
    template: '<div style="padding: 16px"><MarkdownEditor v-model="text" placeholder="## Überschrift" /></div>',
  }),
}

export const Anzeige: Story = {
  name: 'Formatierte Anzeige',
  render: () => ({
    components: { MarkdownView },
    setup() {
      return { source: SAMPLE }
    },
    template: '<div style="padding: 16px; max-width: 760px"><MarkdownView :source="source" /></div>',
  }),
}
