import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import AddToCollectionDialog from '../components/collections/AddToCollectionDialog.vue'
import { defaultHandlers } from './handlers'
import type { CollectionSummary } from '../api/collections'

/**
 * "Ablegen" for any type (#1548): the basket first, a new folder on the spot,
 * then the folders that can take these items. A folder typed for another kind
 * is not offered. For a single item, check marks say where it already lies.
 */

function summary(id: number, name: string, extra: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id, name, description: null, entity_type: null, kind: 'manual', visibility: 'private', group_id: null,
    archived_at: null, created_by: 'user', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    favourite: false, last_opened_at: null, counts: {}, total: 0, can_administer: true, rule: null, ...extra,
  }
}

const COLLECTIONS = [
  summary(1, 'Nebenkosten 2026', { counts: { document: 4, transaction: 12, meter: 2 }, total: 18, favourite: true }),
  summary(2, 'Urlaub Musterstadt', { entity_type: 'photo', counts: { photo: 140 }, total: 140 }),
  summary(3, 'Wasserschaden', { counts: { photo: 6, document: 2 }, total: 8, visibility: 'group', group_id: 1 }),
  summary(4, 'Steuer 2026', { entity_type: 'transaction', counts: { transaction: 40 }, total: 40 }),
]

const listed = http.get('/api/collections', () => HttpResponse.json({ items: COLLECTIONS }))

const meta: Meta<typeof AddToCollectionDialog> = {
  title: 'Components/AddToCollectionDialog',
  component: AddToCollectionDialog,
  parameters: { msw: { handlers: [listed, ...defaultHandlers] } },
  args: { visible: true },
}

export default meta
type Story = StoryObj<typeof AddToCollectionDialog>

/** Photos: the photo folder and the mixed ones, not the transaction folder. */
export const Fotos: Story = {
  args: { members: [{ entity_type: 'photo', entity_id: 1 }, { entity_type: 'photo', entity_id: 2 }] },
}

/** A mixed pick fits only mixed folders. */
export const Gemischt: Story = {
  args: { members: [{ entity_type: 'photo', entity_id: 1 }, { entity_type: 'transaction', entity_id: 9 }] },
}

export const OhneMappen: Story = {
  parameters: { msw: { handlers: defaultHandlers } },
  args: { members: [{ entity_type: 'meter', entity_id: 3 }] },
}

/** One transaction that already lies in two folders: both carry a check mark. */
export const EinzelnAbgelegt: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/collections/of/:type/:id', () =>
          HttpResponse.json({ items: [COLLECTIONS[0], COLLECTIONS[3]] }),
        ),
        listed,
        ...defaultHandlers,
      ],
    },
  },
  args: { members: [{ entity_type: 'transaction', entity_id: 9 }], title: 'Stadtwerke Musterstadt' },
}

/** A document: a new folder can be a dossier seeded from it. */
export const DokumentMitAkte: Story = {
  args: {
    members: [{ entity_type: 'document', entity_id: 5 }],
    dossierSeed: { correspondent_slug: 'stadtwerke', reference_numbers: ['VN-0000-0000'], source_folder_prefix: null },
  },
}
