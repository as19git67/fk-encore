import { http, HttpResponse } from 'msw'
import {
  MOCK_USERS, MOCK_USER, MOCK_ROLES, MOCK_PERMISSIONS,
  MOCK_PHOTOS, MOCK_PERSONS, MOCK_PASSKEYS, MOCK_GROUP,
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
    HttpResponse.json({ user: MOCK_USER, token: 'mock-token' }),
  ),
  http.post('/api/auth/logout', () =>
    HttpResponse.json({ success: true, message: 'Abgemeldet' }),
  ),
  http.post('/api/auth/password', () => HttpResponse.json({ success: true })),

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
  http.delete('/api/photos/:id', () =>
    HttpResponse.json({ success: true, message: 'Gelöscht' }),
  ),
  http.patch('/api/photos/:id/curation', () => HttpResponse.json({ success: true })),
  http.patch('/api/photos/:id/date', () =>
    HttpResponse.json({ success: true, taken_at: '2024-01-01T00:00:00Z' }),
  ),
  http.post('/api/photos/reindex-all', () => HttpResponse.json({ count: 5 })),
  http.get('/api/photos/reindex-status', () =>
    HttpResponse.json({ inProgress: false, total: 0, processed: 0, errors: 0 }),
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
    HttpResponse.json({ results: [] }),
  ),
  http.get('/api/photos/refresh-metadata', () =>
    HttpResponse.json({ ids: [] }),
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
  http.get('/api/photos/:id/faces', () => HttpResponse.json({ faces: [] })),
  http.get('/api/photos/:id/landmarks', () =>
    HttpResponse.json({ landmarks: [], location: undefined }),
  ),
  http.post('/api/photos/:id/reindex', () => HttpResponse.json({ success: true })),
]
