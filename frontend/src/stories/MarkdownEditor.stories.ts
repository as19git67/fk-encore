import type { Meta, StoryObj } from '@storybook/vue3'
import { ref } from 'vue'
import MarkdownEditor from '../components/documents/MarkdownEditor.vue'
import MarkdownView from '../components/documents/MarkdownView.vue'
import ComposeDialog from '../components/documents/ComposeDialog.vue'
import { http, HttpResponse } from 'msw'

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

export const AssistentDialog: StoryObj<typeof ComposeDialog> = {
  name: 'Assistent schreiben lassen',
  parameters: {
    msw: {
      handlers: [
        http.post('/api/assistant/compose', () =>
          HttpResponse.json({ markdown: '## Einladung\n\nWir feiern am **Samstag um 15 Uhr** im Garten.\n\n- Getränke sind da\n- Bitte Salat mitbringen' }),
        ),
      ],
    },
  },
  render: () => ({
    components: { ComposeDialog },
    setup() {
      const visible = ref(true)
      return { visible }
    },
    template: '<ComposeDialog v-model:visible="visible" title="Sommerfest" current-text="Liebe Nachbarn," />',
  }),
}
