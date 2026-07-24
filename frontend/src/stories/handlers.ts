import { http, HttpResponse } from 'msw'
import {
  MOCK_USERS, MOCK_USER, MOCK_ROLES, MOCK_PERMISSIONS,
  MOCK_PHOTOS, MOCK_PERSONS, MOCK_PASSKEYS, MOCK_GROUP,
  MOCK_ALBUMS, MOCK_ALBUM_DETAIL, MOCK_ALBUM_SHARES, MOCK_ALBUM_PUBLIC_LINK,
  MOCK_PUBLIC_ALBUM, MOCK_LIBRARIES, MOCK_AVAILABLE_PATHS,
  MOCK_SCAN_QUEUE_IDLE, MOCK_SERVICES_OK, MOCK_SERVER_PRESSURE_OK,
  MOCK_FACES,
  MOCK_DOCUMENTS, MOCK_DOCUMENT_CATEGORIES, MOCK_DOCUMENT_DETAIL,
  MOCK_DOCUMENT_QUEUE_IDLE,
} from './mock-data'

// Generates a deterministic placeholder SVG for a photo filename
function placeholderSvg(filename: string): string {
  const hue = filename.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360
  const label = filename.replace(/\.[^.]+$/, '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
    <rect width="800" height="600" fill="hsl(${hue},50%,38%)"/>
    <text x="400" y="300" font-family="sans-serif" font-size="40" fill="rgba(255,255,255,0.9)"
          text-anchor="middle" dominant-baseline="middle">${label}</text>
  </svg>`
}

export const defaultHandlers = [
  // ── Users ──────────────────────────────────────────────────────────────────
  http.get('/api/users', () => HttpResponse.json({ users: MOCK_USERS })),
  http.get('/api/users/:id', () => HttpResponse.json(MOCK_USER)),
  http.put('/api/users/:id', () => HttpResponse.json(MOCK_USER)),
  http.delete('/api/users/:id', () => HttpResponse.json({ success: true, message: 'Gelöscht' })),

  // ── Auth ───────────────────────────────────────────────────────────────────
  http.post('/api/auth/login', () =>
    HttpResponse.json({ user: MOCK_USER, token: 'mock-token', refreshToken: 'mock-refresh-token' }),
  ),
  http.post('/api/auth/logout', () =>
    HttpResponse.json({ success: true, message: 'Abgemeldet' }),
  ),
  http.post('/api/auth/refresh', () =>
    HttpResponse.json({ user: MOCK_USER, token: 'mock-token-refreshed', refreshToken: 'mock-refresh-token-refreshed' }),
  ),
  http.post('/api/auth/password', () => HttpResponse.json({ success: true })),
  http.post('/api/auth/request-password-reset', () =>
    HttpResponse.json({ success: true, message: 'Sofern die Adresse bekannt ist, wurde ein Link versendet.' }),
  ),
  http.post('/api/auth/reset-password', () =>
    HttpResponse.json({ success: true, message: 'Passwort wurde zurückgesetzt.' }),
  ),

  // ── Passkeys ───────────────────────────────────────────────────────────────
  http.get('/api/auth/passkeys', () =>
    HttpResponse.json({ passkeys: MOCK_PASSKEYS }),
  ),
  http.delete('/api/auth/passkeys/:credentialId', () =>
    HttpResponse.json({ success: true, message: 'Gelöscht' }),
  ),

  // ── Roles & Permissions ────────────────────────────────────────────────────
  http.get('/api/roles', () => HttpResponse.json({ roles: MOCK_ROLES })),
  http.post('/api/roles', () => HttpResponse.json(MOCK_ROLES[0]!)),
  http.delete('/api/roles/:id', () =>
    HttpResponse.json({ success: true, message: 'Gelöscht' }),
  ),
  http.get('/api/permissions', () =>
    HttpResponse.json({ permissions: MOCK_PERMISSIONS }),
  ),
  http.post('/api/roles/:id/permissions', () =>
    HttpResponse.json({ roleId: 1, permissions: MOCK_PERMISSIONS }),
  ),
  http.delete('/api/roles/:id/permissions/:permId', () =>
    HttpResponse.json({ success: true, message: 'Entfernt' }),
  ),
  http.post('/api/users/:id/roles', () =>
    HttpResponse.json({ userId: 1, roles: MOCK_USER.roles }),
  ),
  http.delete('/api/users/:id/roles/:roleId', () =>
    HttpResponse.json({ success: true, message: 'Entfernt' }),
  ),

  // ── Photos ─────────────────────────────────────────────────────────────────
  http.get('/api/photos', () => HttpResponse.json({ photos: MOCK_PHOTOS })),
  http.get('/api/photos/index', () => HttpResponse.json({ photos: MOCK_PHOTOS })),
  http.get('/api/photos/details', ({ request }) => {
    const url = new URL(request.url)
    const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => Number(s)).filter(Boolean)
    const photos = ids.length === 0
      ? MOCK_PHOTOS
      : MOCK_PHOTOS.filter((p) => ids.includes(p.id))
    return HttpResponse.json({ photos })
  }),
  http.delete('/api/photos/:id', () =>
    HttpResponse.json({ success: true, message: 'Gelöscht' }),
  ),
  http.delete('/api/photos/:id/hard', () =>
    HttpResponse.json({ success: true, message: 'Endgültig gelöscht' }),
  ),
  http.patch('/api/photos/:id/curation', () => HttpResponse.json({ success: true })),
  http.patch('/api/photos/:id/date', () =>
    HttpResponse.json({ success: true, taken_at: '2024-01-01T00:00:00Z' }),
  ),
  http.patch('/api/photos/:id/description', () =>
    HttpResponse.json({ success: true, description: '' }),
  ),
  http.post('/api/photos/:id/refresh-metadata', () =>
    HttpResponse.json({ success: true, taken_at: '2024-01-01T00:00:00Z' }),
  ),
  http.get('/api/photos/scan-queue/status', () => HttpResponse.json(MOCK_SCAN_QUEUE_IDLE)),
  http.post('/api/photos/scan-queue/retry-failed', () => HttpResponse.json({ retried: 0 })),
  http.post('/api/photos/scan-queue/cancel', () => HttpResponse.json({ cancelled: 0 })),
  http.post('/api/photos/rescan', () => HttpResponse.json({ queued: 0 })),
  http.get('/api/photos/needs-gps-rescan', () => HttpResponse.json({ ids: [] })),
  http.post('/api/photos/:id/rescan-gps', () =>
    HttpResponse.json({ gpsFound: false, geocoded: false, scansQueued: false }),
  ),
  http.post('/api/photos/recompute-auto-crops', () => HttpResponse.json({ updated: 0 })),
  http.post('/api/photos/purge', () =>
    HttpResponse.json({
      success: true,
      dbCounts: { photos: 0, faces: 0, persons: 0 },
      files: { deleted: true, uploadsRemoved: 0, thumbnailsRemoved: 0, failures: 0 },
      embeddingService: { called: true, ok: true, deleted: 0, error: '' },
    }),
  ),
  http.get('/api/photos/service-health', () =>
    HttpResponse.json({ services: MOCK_SERVICES_OK, serverPressure: MOCK_SERVER_PRESSURE_OK }),
  ),
  http.post('/api/photos/find-groups', () =>
    HttpResponse.json({ groups_created: 1, total_photos_grouped: 3 }),
  ),
  http.get('/api/photos/groups', () =>
    HttpResponse.json({ groups: [MOCK_GROUP] }),
  ),
  http.get('/api/photos/groups/next-unreviewed', () =>
    HttpResponse.json(null),
  ),
  http.post('/api/photos/groups/:id/review', () =>
    HttpResponse.json({ success: true }),
  ),
  http.post('/api/photos/search', () =>
    HttpResponse.json({ photos: [] }),
  ),
  http.post('/api/photos/search/natural', () =>
    HttpResponse.json({ results: [], parsed: { semanticQuery: '' } }),
  ),
  http.get('/api/photos/refresh-metadata', () =>
    HttpResponse.json({ ids: [] }),
  ),
  http.get('/api/photos/albums', () =>
    HttpResponse.json({ results: [] }),
  ),
  http.get('/api/photos/:id/locations', ({ params }) =>
    HttpResponse.json({
      photoId: Number(params.id),
      albums: [{ id: 1, name: MOCK_ALBUMS[0]!.name }],
      persons: [],
      hasGps: true,
    }),
  ),

  // ── Photo thumbnails: serve from /mock-photos/ or generated SVG ────────────
  http.get('/api/photos/file/:filename', async ({ params }) => {
    const filename = params.filename as string
    try {
      const res = await fetch(`/mock-photos/${filename}`)
      if (res.ok) {
        const blob = await res.blob()
        return new Response(blob, {
          headers: { 'Content-Type': blob.type || 'image/jpeg' },
        })
      }
    } catch {
      // fall through to placeholder
    }
    const svg = placeholderSvg(filename)
    return new HttpResponse(svg, {
      headers: { 'Content-Type': 'image/svg+xml' },
    })
  }),

  // ── Persons & Faces ────────────────────────────────────────────────────────
  http.get('/api/persons', () =>
    HttpResponse.json({ persons: MOCK_PERSONS, enableLocalFaces: false }),
  ),
  http.get('/api/persons/:id', () =>
    HttpResponse.json({ ...MOCK_PERSONS[0]!, faces: [] }),
  ),
  http.patch('/api/persons/:id', () => HttpResponse.json(MOCK_PERSONS[0]!)),
  http.post('/api/persons/merge', () => HttpResponse.json({ success: true })),
  http.post('/api/faces/:id/assign', () => HttpResponse.json({ success: true })),
  http.post('/api/faces/:id/ignore', () => HttpResponse.json({ success: true })),
  http.post('/api/persons/:id/ignore', () => HttpResponse.json({ success: true })),
  http.get('/api/photos/:id/faces', () => HttpResponse.json({ faces: MOCK_FACES })),
  http.post('/api/photos/:id/reindex', () => HttpResponse.json({ success: true })),

  // ── Albums ─────────────────────────────────────────────────────────────────
  http.get('/api/albums', () => HttpResponse.json({ albums: MOCK_ALBUMS })),
  http.post('/api/albums', () => HttpResponse.json(MOCK_ALBUMS[0]!)),
  http.patch('/api/albums', () => HttpResponse.json(MOCK_ALBUMS[0]!)),
  http.get('/api/albums/:id', () => HttpResponse.json(MOCK_ALBUM_DETAIL)),
  http.delete('/api/albums/:id', () =>
    HttpResponse.json({ success: true, message: 'Gelöscht' }),
  ),
  http.post('/api/albums/photos', () => HttpResponse.json({ success: true })),
  http.post('/api/albums/photos/batch', () => HttpResponse.json({ success: true })),
  http.patch('/api/albums/:id/settings', () =>
    HttpResponse.json(MOCK_ALBUM_DETAIL.settings),
  ),
  http.post('/api/albums/:id/batch-favorite', () =>
    HttpResponse.json({ success: true, favorited: 0 }),
  ),
  http.post('/api/albums/share', () => HttpResponse.json({ success: true })),
  http.get('/api/albums/:id/shares', () =>
    HttpResponse.json({ shares: MOCK_ALBUM_SHARES, publicLink: MOCK_ALBUM_PUBLIC_LINK }),
  ),
  http.delete('/api/albums/:id/shares/:userId', () =>
    HttpResponse.json({ success: true }),
  ),
  http.post('/api/albums/:id/public-link', () =>
    HttpResponse.json(MOCK_ALBUM_PUBLIC_LINK),
  ),
  http.delete('/api/albums/:id/public-link', () =>
    HttpResponse.json({ success: true }),
  ),
  http.get('/api/albums/public/:token', () => HttpResponse.json(MOCK_PUBLIC_ALBUM)),

  // ── Libraries ──────────────────────────────────────────────────────────────
  http.get('/api/libraries', () => HttpResponse.json({ libraries: MOCK_LIBRARIES })),
  http.get('/api/libraries/available-paths', () => HttpResponse.json(MOCK_AVAILABLE_PATHS)),
  http.get('/api/libraries/:id', ({ params }) => {
    const id = Number(params.id)
    const lib = MOCK_LIBRARIES.find((l) => l.id === id) ?? MOCK_LIBRARIES[0]!
    return HttpResponse.json(lib)
  }),
  http.post('/api/libraries', () => HttpResponse.json(MOCK_LIBRARIES[0]!)),
  http.patch('/api/libraries/:id', () => HttpResponse.json(MOCK_LIBRARIES[0]!)),
  http.delete('/api/libraries/:id', () => HttpResponse.json({ success: true })),
  http.post('/api/libraries/:id/scan', () =>
    HttpResponse.json({
      scanned: 42, imported: 10, skipped_duplicate: 30,
      skipped_unsupported: 1, skipped_empty: 0, errors: 1,
    }),
  ),
  http.post('/api/libraries/:id/reconcile', () => HttpResponse.json({ removed: 0 })),

  // ── Documents ──────────────────────────────────────────────────────────────
  http.get('/api/documents', ({ request }) => {
    const url = new URL(request.url)
    const category = url.searchParams.get('category')
    const status = url.searchParams.get('status')
    let items = MOCK_DOCUMENTS
    if (category) items = items.filter((d) => d.category_slug === category)
    if (status) items = items.filter((d) => d.status === status)
    return HttpResponse.json({ items, total: items.length })
  }),
  http.get('/api/documents/search', ({ request }) => {
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const mode = (url.searchParams.get('mode') ?? 'hybrid') as 'fts' | 'semantic' | 'hybrid'
    const items = q.length === 0
      ? MOCK_DOCUMENTS
      : MOCK_DOCUMENTS.filter((d) =>
        (d.title ?? '').toLowerCase().includes(q) ||
        d.original_filename.toLowerCase().includes(q) ||
        (d.sender ?? '').toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q)),
      )
    return HttpResponse.json({ items, mode, query: q })
  }),
  http.get('/api/document-categories', () =>
    HttpResponse.json({ items: MOCK_DOCUMENT_CATEGORIES }),
  ),
  http.get('/api/document-types', () =>
    HttpResponse.json({
      items: [
        { slug: 'rechnung', name: 'Rechnung / Mahnung' },
        { slug: 'vertrag', name: 'Vertrag / Police' },
        { slug: 'bescheid', name: 'Bescheid / Festsetzung' },
        { slug: 'gutschrift', name: 'Gutschrift / Erstattung' },
        { slug: 'bescheinigung', name: 'Bescheinigung / Nachweis' },
      ],
    }),
  ),
  http.get('/api/document-queue/status', () =>
    HttpResponse.json(MOCK_DOCUMENT_QUEUE_IDLE),
  ),
  http.get('/api/documents/:id', ({ params }) => {
    const id = Number(params.id)
    const summary = MOCK_DOCUMENTS.find((d) => d.id === id) ?? MOCK_DOCUMENTS[0]!
    return HttpResponse.json({
      ...summary,
      summary: MOCK_DOCUMENT_DETAIL.summary,
      extracted_text_preview: MOCK_DOCUMENT_DETAIL.extracted_text_preview,
    })
  }),
  http.patch('/api/documents/:id', async ({ params, request }) => {
    const id = Number(params.id)
    const summary = MOCK_DOCUMENTS.find((d) => d.id === id) ?? MOCK_DOCUMENTS[0]!
    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>
    return HttpResponse.json({
      ...summary,
      ...patch,
      summary: (patch.summary as string) ?? MOCK_DOCUMENT_DETAIL.summary,
      extracted_text_preview: MOCK_DOCUMENT_DETAIL.extracted_text_preview,
    })
  }),
  http.delete('/api/documents/:id', () => HttpResponse.json({ success: true })),
  http.post('/api/documents/:id/reclassify', () => HttpResponse.json({ success: true })),
  http.post('/api/documents', () => HttpResponse.json(MOCK_DOCUMENTS[0]!)),
  http.get('/api/documents/:id/file', () => {
    // Minimal valid PDF ("%PDF-…") so the iframe doesn't show a network error.
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n'
    return new HttpResponse(pdf, { headers: { 'Content-Type': 'application/pdf' } })
  }),

  // ── System ─────────────────────────────────────────────────────────────────
  http.get('/api/build-info', () => HttpResponse.json({ build: 'storybook-dev' })),
]
