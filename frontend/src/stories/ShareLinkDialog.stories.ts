import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import ShareLinkDialog from '../components/collections/ShareLinkDialog.vue'
import { defaultHandlers } from './handlers'
import type { CollectionPublicLink } from '../api/collections'

/** "Freigabelink" for a collection (#1548, stage 8): the live links and a new one. */

function handlers(items: CollectionPublicLink[]) {
  return [
    http.get('/api/collections/:id/public-links', () => HttpResponse.json({ items })),
    http.post('/api/collections/:id/public-links', () =>
      HttpResponse.json({
        id: 9,
        collection_id: 1,
        token: 'neuerLinkBeispielToken0123456789',
        created_at: '2026-10-16T08:00:00Z',
        expires_at: '2026-11-15T08:00:00Z',
      }),
    ),
    http.delete('/api/collections/public-links/:linkId', () => HttpResponse.json({ ok: true })),
    ...defaultHandlers,
  ]
}

const meta: Meta<typeof ShareLinkDialog> = {
  title: 'Components/ShareLinkDialog',
  component: ShareLinkDialog,
  args: { visible: true, collectionId: 1, name: 'Sommerurlaub' },
}

export default meta
type Story = StoryObj<typeof ShareLinkDialog>

export const MitLinks: Story = {
  parameters: {
    msw: {
      handlers: handlers([
        { id: 2, collection_id: 1, token: 'beispielTokenAbc0123456789xyz', created_at: '2026-10-10T08:00:00Z', expires_at: '2026-11-09T08:00:00Z' },
        { id: 1, collection_id: 1, token: 'beispielTokenDef0123456789uvw', created_at: '2026-09-01T08:00:00Z', expires_at: null },
      ]),
    },
  },
}

export const OhneLinks: Story = {
  parameters: { msw: { handlers: handlers([]) } },
}
