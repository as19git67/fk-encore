import type { UserWithRoles } from '../api/users'
import type { Photo, Person, PhotoGroup } from '../api/photos'
import type { RoleWithPermissions, Permission } from '../api/roles'
import type { PasskeyInfo } from '../api/passkeys'

// ── Auth ──────────────────────────────────────────────────────────────────────

export const MOCK_USER: UserWithRoles = {
  id: 1,
  email: 'admin@example.com',
  name: 'Admin Benutzer',
  created_at: '2024-01-15T08:00:00Z',
  updated_at: '2024-01-15T08:00:00Z',
  roles: [{ id: 1, name: 'admin', description: 'Administrator' }],
  permissions: [
    'users.list', 'users.read', 'users.write',
    'roles.list', 'roles.write',
    'photos.view', 'photos.upload', 'photos.delete',
    'people.view',
    'data.manage',
  ],
}

// ── Users ─────────────────────────────────────────────────────────────────────

export const MOCK_USERS: UserWithRoles[] = [
  MOCK_USER,
  {
    id: 2,
    email: 'maria@example.com',
    name: 'Maria Schmidt',
    created_at: '2024-02-01T09:00:00Z',
    updated_at: '2024-02-01T09:00:00Z',
    roles: [{ id: 2, name: 'viewer', description: 'Nur-Lesen' }],
    permissions: ['photos.view'],
  },
  {
    id: 3,
    email: 'hans@example.com',
    name: 'Hans Müller',
    created_at: '2024-03-10T14:00:00Z',
    updated_at: '2024-03-10T14:00:00Z',
    roles: [],
    permissions: [],
  },
]

// ── Roles & Permissions ───────────────────────────────────────────────────────

export const MOCK_PERMISSIONS: Permission[] = [
  { id: 1, key: 'users.list',    description: 'Benutzerliste anzeigen' },
  { id: 2, key: 'users.read',    description: 'Benutzerdetails lesen' },
  { id: 3, key: 'users.write',   description: 'Benutzer bearbeiten' },
  { id: 4, key: 'roles.list',    description: 'Rollenliste anzeigen' },
  { id: 5, key: 'roles.write',   description: 'Rollen bearbeiten' },
  { id: 6, key: 'photos.view',   description: 'Fotos anzeigen' },
  { id: 7, key: 'photos.upload', description: 'Fotos hochladen' },
  { id: 8, key: 'people.view',   description: 'Personen anzeigen' },
  { id: 9, key: 'data.manage',   description: 'Datenverwaltung' },
]

export const MOCK_ROLES: RoleWithPermissions[] = [
  {
    id: 1,
    name: 'admin',
    description: 'Vollzugriff auf alle Funktionen',
    permissions: MOCK_PERMISSIONS,
  },
  {
    id: 2,
    name: 'viewer',
    description: 'Nur Fotos anzeigen',
    permissions: [MOCK_PERMISSIONS[5]!],
  },
  {
    id: 3,
    name: 'uploader',
    description: 'Fotos hochladen und anzeigen',
    permissions: [MOCK_PERMISSIONS[5]!, MOCK_PERMISSIONS[6]!],
  },
]

// ── Photos ────────────────────────────────────────────────────────────────────

export const MOCK_PHOTOS: Photo[] = [
  {
    id: 1,
    user_id: 1,
    filename: 'museum.jpg',
    original_name: 'Museum.jpg',
    mime_type: 'image/jpeg',
    size: 3_145_728,
    taken_at: '2024-03-15T10:30:00Z',
    created_at: '2024-03-15T10:30:00Z',
    curation_status: 'visible',
  },
  {
    id: 2,
    user_id: 1,
    filename: 'steak.jpg',
    original_name: 'Steak.jpg',
    mime_type: 'image/jpeg',
    size: 2_097_152,
    taken_at: '2024-04-20T19:00:00Z',
    created_at: '2024-04-20T19:00:00Z',
    curation_status: 'favorite',
  },
  {
    id: 3,
    user_id: 1,
    filename: 'seagull.jpg',
    original_name: 'Seagull.jpg',
    mime_type: 'image/jpeg',
    size: 1_572_864,
    taken_at: '2024-05-10T16:45:00Z',
    created_at: '2024-05-10T16:45:00Z',
    curation_status: 'visible',
  },
  {
    id: 4,
    user_id: 1,
    filename: 'castle.jpg',
    original_name: 'Castle.jpg',
    mime_type: 'image/jpeg',
    size: 4_194_304,
    taken_at: '2024-02-28T12:00:00Z',
    created_at: '2024-02-28T12:00:00Z',
    curation_status: 'visible',
  },
  {
    id: 5,
    user_id: 1,
    filename: 'fish.jpg',
    original_name: 'Fish.jpg',
    mime_type: 'image/jpeg',
    size: 2_621_440,
    taken_at: '2024-06-05T14:20:00Z',
    created_at: '2024-06-05T14:20:00Z',
    curation_status: 'hidden',
  },
]

// ── Photo Groups ──────────────────────────────────────────────────────────────

export const MOCK_GROUP: PhotoGroup = {
  id: 1,
  user_id: 1,
  cover_photo_id: 1,
  created_at: '2024-03-15T10:30:00Z',
  member_count: 3,
  photo_ids: [1, 2, 3],
}

// ── Persons ───────────────────────────────────────────────────────────────────

export const MOCK_PERSONS: Person[] = [
  {
    id: 1,
    user_id: 1,
    name: 'Unbekannte Person',
    cover_face_id: undefined,
    cover_filename: 'seagull.jpg',
    cover_bbox: { x: 0.15, y: 0.13, width: 0.08, height: 0.12 },
    created_at: '2024-05-10T16:45:00Z',
    updated_at: '2024-05-10T16:45:00Z',
    faceCount: 3,
  },
  {
    id: 2,
    user_id: 1,
    name: 'Anna Beispiel',
    cover_face_id: undefined,
    cover_filename: 'museum.jpg',
    cover_bbox: { x: 0.25, y: 0.17, width: 0.07, height: 0.11 },
    created_at: '2024-03-15T10:30:00Z',
    updated_at: '2024-03-15T10:30:00Z',
    faceCount: 7,
  },
]

// ── Passkeys ──────────────────────────────────────────────────────────────────

export const MOCK_PASSKEYS: PasskeyInfo[] = [
  {
    credential_id: 'cred-abc123',
    name: 'MacBook Pro',
    device_type: 'platform',
    backed_up: true,
    created_at: '2024-01-20T10:00:00Z',
  },
  {
    credential_id: 'cred-def456',
    name: 'iPhone',
    device_type: 'platform',
    backed_up: true,
    created_at: '2024-02-05T14:30:00Z',
  },
]
