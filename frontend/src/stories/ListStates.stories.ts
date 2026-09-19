import type { Meta, StoryObj } from '@storybook/vue3'
import Button from 'primevue/button'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'

/**
 * The three panels a list shows when it has no rows to show (issue #1272,
 * stage 3): still loading, nothing found, or loading failed.
 */
const meta: Meta = {
  title: 'Layout/Listenzustände',
}

export default meta
type Story = StoryObj

export const Leer: Story = {
  name: 'EmptyState',
  render: () => ({
    components: { EmptyState },
    template: `
      <EmptyState
        icon="pi pi-file"
        title="Noch keine Dokumente vorhanden"
        message="Lade ein Dokument hoch oder lass den Scan-Ordner überwachen."
      />
    `,
  }),
}

export const LeerGefiltert: Story = {
  name: 'EmptyState (Filter aktiv)',
  render: () => ({
    components: { EmptyState },
    template: `
      <EmptyState
        icon="pi pi-file"
        title="Keine Treffer für „Energiekosten“"
        message="Andere Wörter oder ein anderer Suchmodus finden vielleicht mehr."
        filtered
      />
    `,
  }),
}

export const LeerMitAktion: Story = {
  name: 'EmptyState (mit eigener Aktion)',
  render: () => ({
    components: { EmptyState, Button },
    template: `
      <EmptyState icon="pi pi-check-circle" title="Keine offenen Gruppen.">
        <template #action>
          <Button label="Zurück zur Galerie" icon="pi pi-images" size="small" text />
        </template>
      </EmptyState>
    `,
  }),
}

export const SkelettListe: Story = {
  name: 'PageSkeleton (Liste)',
  render: () => ({
    components: { PageSkeleton },
    template: '<PageSkeleton variant="list" :count="5" />',
  }),
}

export const SkelettRaster: Story = {
  name: 'PageSkeleton (Kacheln)',
  render: () => ({
    components: { PageSkeleton },
    template: '<PageSkeleton variant="grid" :count="8" />',
  }),
}

export const SkelettTabelle: Story = {
  name: 'PageSkeleton (Tabelle)',
  render: () => ({
    components: { PageSkeleton },
    template: '<PageSkeleton variant="table" :count="6" />',
  }),
}

export const Fehler: Story = {
  name: 'ErrorBanner',
  render: () => ({
    components: { ErrorBanner },
    template: `
      <ErrorBanner message="Dokumente konnten nicht geladen werden (Netzwerkfehler)." />
    `,
  }),
}

export const FehlerSchliessbar: Story = {
  name: 'ErrorBanner (schließbar)',
  render: () => ({
    components: { ErrorBanner },
    template: `
      <ErrorBanner
        message="Die Suche ist fehlgeschlagen. Ist der Embedding-Service erreichbar?"
        closable
      />
    `,
  }),
}
