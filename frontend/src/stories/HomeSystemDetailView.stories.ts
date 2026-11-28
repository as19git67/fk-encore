import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import HomeSystemDetailView from '../views/HomeSystemDetailView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { HomeSystemDetail } from '../api/home'

/** One invented system with a guide (steps, a warning, a photo), items, notes and photos. */

const SYSTEM: HomeSystemDetail = {
  id: 3,
  name: 'Perlatoren',
  category: 'sanitary',
  location: 'Alle Armaturen',
  manufacturer: 'Beispielwerk',
  model: null,
  installedOn: '2021-04-01',
  description: 'Strahlregler an jeder Armatur im Haus. **Zweimal im Jahr** entkalken.',
  archived: false,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-20T10:00:00Z',
  groupId: 7,
  groupName: 'Familie',
  household: true,
  ownerUserId: 1,
  ownerName: 'Admin',
  canManage: true,
  guides: [
    {
      id: 11,
      title: 'Perlatoren entkalken',
      body: [
        '> [!WARNING]',
        '> Den Schlüssel nicht mit der Zange ansetzen, sonst verkratzt die Oberfläche.',
        '',
        '1. Perlator mit dem passenden Schlüssel abschrauben.',
        '2. Über Nacht in Essigwasser (1:1) legen.',
        '3. Ausspülen, Dichtung prüfen, wieder einschrauben.',
        '',
        '![Perlator mit Dichtung](media:43)',
        '',
        '> [!NOTE]',
        '> Ersatzdichtungen liegen im Teileschrank, Schublade 2.',
      ].join('\n'),
      sort: 0,
      updatedAt: '2026-11-18T19:20:00Z',
      updatedByName: 'Admin',
      revisionCount: 2,
    },
    {
      id: 12,
      title: 'Perlator wechseln',
      body: 'Gleiches Gewinde und gleiche Durchflussklasse kaufen.',
      sort: 1,
      updatedAt: '2026-11-02T08:00:00Z',
      updatedByName: 'Admin',
      revisionCount: 0,
    },
  ],
  items: [
    { id: 21, label: 'Küche', location: 'Spüle', attributes: [{ key: 'Gewinde', value: 'M24×1 außen' }, { key: 'Schlüssel', value: 'Typ A' }], sort: 0 },
    { id: 22, label: 'Bad oben', location: 'Waschtisch', attributes: [{ key: 'Gewinde', value: 'M22×1 innen' }, { key: 'Schlüssel', value: 'Typ B' }], sort: 1 },
    { id: 23, label: 'Gäste-WC', location: 'Handwaschbecken', attributes: [{ key: 'Gewinde', value: 'M18×1 versteckt' }, { key: 'Schlüssel', value: 'Typ C' }], sort: 2 },
  ],
  notes: [
    { id: 31, notedOn: '2026-11-15', body: 'Alle entkalkt, Küche neue Dichtung.', authorId: 1, authorName: 'Admin', createdAt: '2026-11-15T18:00:00Z', updatedAt: '2026-11-15T18:00:00Z' },
    { id: 32, notedOn: '2026-05-03', body: 'Bad oben: Perlator ersetzt.', authorId: 1, authorName: 'Admin', createdAt: '2026-05-03T18:00:00Z', updatedAt: '2026-05-03T18:00:00Z' },
  ],
  media: [
    { id: 41, targetKind: 'system', targetId: 3, caption: 'Schlüsselsatz', width: 2048, height: 1365, createdAt: '2026-11-01T10:00:00Z' },
    { id: 42, targetKind: 'system', targetId: 3, caption: null, width: 2048, height: 1365, createdAt: '2026-11-01T10:00:00Z' },
    { id: 43, targetKind: 'guide', targetId: 11, caption: null, width: 2048, height: 1365, createdAt: '2026-11-01T10:00:00Z' },
    { id: 44, targetKind: 'item', targetId: 21, caption: null, width: 2048, height: 1365, createdAt: '2026-11-01T10:00:00Z' },
    { id: 45, targetKind: 'note', targetId: 31, caption: 'Neue Dichtung', width: 2048, height: 1365, createdAt: '2026-11-15T18:00:00Z' },
  ],
}

/** A drawn stand-in for a photo: a tap aerator on a plain background. */
function drawing(id: string): string {
  const hue = (Number(id) * 47) % 360
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
    <rect width="600" height="400" fill="hsl(${hue} 30% 82%)"/>
    <circle cx="300" cy="200" r="110" fill="hsl(${hue} 15% 60%)"/>
    <circle cx="300" cy="200" r="70" fill="hsl(${hue} 10% 92%)"/>
  </svg>`
}

const handlers = [
  http.get('/api/home/systems/:id', () => HttpResponse.json(SYSTEM)),
  http.get('/api/home/media/:id/file', ({ params }) =>
    new HttpResponse(drawing(String(params.id)), { headers: { 'Content-Type': 'image/svg+xml' } }),
  ),
  http.get('/api/home/systems/:id/guides/:guideId/revisions', () =>
    HttpResponse.json({
      revisions: [
        { id: 2, title: 'Perlatoren entkalken', body: '1. Abschrauben.\n2. In Essig legen.', editedAt: '2026-11-10T09:00:00Z', editedByName: 'Admin' },
        { id: 1, title: 'Entkalken', body: 'In Essig legen.', editedAt: '2026-11-01T10:00:00Z', editedByName: 'Admin' },
      ],
    }),
  ),
  http.get('/api/home/share-groups', () => HttpResponse.json({ householdId: 7, groups: [{ id: 7, name: 'Familie', household: true }] })),
  ...defaultHandlers,
]

const meta: Meta<typeof HomeSystemDetailView> = {
  title: 'Views/HomeSystemDetailView',
  component: HomeSystemDetailView,
  decorators: [routeFromParameters('/haus/anlagen/3')],
  parameters: { msw: { handlers } },
}

export default meta
type Story = StoryObj<typeof HomeSystemDetailView>

export const Anlage: Story = { name: 'Anlage mit Anleitung, Einzelteilen und Notizen' }

export const Telefon: Story = {
  name: 'Auf dem Telefon',
  parameters: { testViewport: { width: 360, height: 800 } },
}
