import type { UserWithRoles } from '../api/users'
import type {
  Photo,
  Person,
  PhotoGroup,
  Album,
  AlbumWithPhotos,
  AlbumPhoto,
  AlbumShareWithUser,
  AlbumPublicLink,
  PublicAlbumResponse,
  ScanQueueStatus,
  ExternalServiceHealth,
  ServerPressureStatus,
  Face,
} from '../api/photos'
import type { RoleWithPermissions, Permission } from '../api/roles'
import type { PasskeyInfo } from '../api/passkeys'
import type { PhotoLibrary, AvailablePathsResponse } from '../api/libraries'
import type {
  DocumentSummary,
  DocumentDetail,
  DocumentCategory,
  DocQueueStatus as DocumentQueueStatus,
} from '../api/documents'

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
    'photos.purge',
    'photos.libraries.manage',
    'people.view',
    'data.manage',
    'documents.view', 'documents.upload', 'documents.edit', 'documents.delete',
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
    latitude: 48.1478,
    longitude: 11.5683,
    location_name: 'Deutsches Museum',
    location_city: 'München',
    location_country: 'Deutschland',
    location_short: 'München',
    ai_quality_score: 0.82,
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
    latitude: 53.5413,
    longitude: 9.9833,
    location_name: 'Hamburger Hafen',
    location_city: 'Hamburg',
    location_country: 'Deutschland',
    location_short: 'Hamburg',
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
    latitude: 47.5576,
    longitude: 10.7498,
    location_name: 'Schloss Neuschwanstein',
    location_city: 'Schwangau',
    location_country: 'Deutschland',
    location_short: 'Schwangau',
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

// ── Faces ─────────────────────────────────────────────────────────────────────

export const MOCK_FACES: Face[] = [
  {
    id: 101,
    user_id: 1,
    photo_id: 1,
    bbox: { x: 0.25, y: 0.17, width: 0.07, height: 0.11 },
    person_id: 2,
    quality: 0.85,
    ignored: false,
    created_at: '2024-03-15T10:30:00Z',
  },
  {
    id: 102,
    user_id: 1,
    photo_id: 1,
    bbox: { x: 0.55, y: 0.2, width: 0.06, height: 0.1 },
    ignored: false,
    created_at: '2024-03-15T10:30:00Z',
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

// ── Albums ────────────────────────────────────────────────────────────────────

export const MOCK_ALBUMS: Album[] = [
  {
    id: 1,
    user_id: 1,
    name: 'Städtereise München',
    description: 'Ein Wochenende in der bayerischen Hauptstadt',
    cover_photo_id: 1,
    cover_filename: 'museum.jpg',
    display_mode: 'map',
    newest_photo_at: '2024-03-15T10:30:00Z',
    oldest_photo_at: '2024-03-15T10:30:00Z',
    photo_count: 12,
    is_shared: true,
    created_at: '2024-03-16T08:00:00Z',
    updated_at: '2024-03-16T08:00:00Z',
  },
  {
    id: 2,
    user_id: 1,
    name: 'Schlösser & Burgen',
    description: 'Rundreise durch Bayern',
    cover_photo_id: 4,
    cover_filename: 'castle.jpg',
    display_mode: 'grid',
    newest_photo_at: '2024-02-28T12:00:00Z',
    oldest_photo_at: '2024-02-28T12:00:00Z',
    photo_count: 8,
    is_shared: false,
    created_at: '2024-03-01T08:00:00Z',
    updated_at: '2024-03-01T08:00:00Z',
  },
  {
    id: 3,
    user_id: 1,
    name: 'Nordsee 2024',
    cover_photo_id: 3,
    cover_filename: 'seagull.jpg',
    display_mode: 'grid',
    newest_photo_at: '2024-05-10T16:45:00Z',
    oldest_photo_at: '2024-05-10T16:45:00Z',
    photo_count: 24,
    is_shared: false,
    created_at: '2024-05-11T08:00:00Z',
    updated_at: '2024-05-11T08:00:00Z',
  },
]

export const MOCK_ALBUM_PHOTOS: AlbumPhoto[] = MOCK_PHOTOS.slice(0, 4).map((p) => ({
  ...p,
  added_by_user_id: 1,
  added_at: p.created_at,
  curation_stats: { fav_count: 1, hide_count: 0, member_count: 1 },
}))

export const MOCK_ALBUM_DETAIL: AlbumWithPhotos = {
  ...MOCK_ALBUMS[0]!,
  role: 'owner',
  photos: MOCK_ALBUM_PHOTOS,
  settings: {
    album_id: 1,
    user_id: 1,
    hide_mode: 'mine',
    active_view: 'all',
    view_config: null,
    cover_photo_id: 1,
  },
}

export const MOCK_ALBUM_SHARES: AlbumShareWithUser[] = [
  {
    album_id: 1,
    user_id: 2,
    access_level: 'read',
    invited_by_user_id: 1,
    user_name: 'Maria Schmidt',
    user_email: 'maria@example.com',
  },
]

export const MOCK_ALBUM_PUBLIC_LINK: AlbumPublicLink = {
  id: 42,
  album_id: 1,
  token: 'abcd1234ef567890',
  created_by_user_id: 1,
  created_at: '2024-03-20T10:00:00Z',
  expires_at: '2025-03-20T10:00:00Z',
}

export const MOCK_PUBLIC_ALBUM: PublicAlbumResponse = {
  id: 1,
  name: 'Städtereise München',
  description: 'Ein Wochenende in der bayerischen Hauptstadt',
  display_mode: 'map',
  cover_filename: 'museum.jpg',
  newest_photo_at: '2024-03-15T10:30:00Z',
  oldest_photo_at: '2024-03-15T10:30:00Z',
  photo_count: MOCK_ALBUM_PHOTOS.length,
  photos: MOCK_ALBUM_PHOTOS.map(({ added_by_user_id: _a, added_at: _b, curation_stats: _c, ...rest }) => rest),
}

// ── Libraries ─────────────────────────────────────────────────────────────────

export const MOCK_LIBRARIES: PhotoLibrary[] = [
  {
    id: 1,
    user_id: 1,
    name: 'Urlaub 2024',
    path: 'Urlaub/2024',
    import_mode: 'link',
    auto_import: true,
    auto_albums: true,
    favorite_rating_threshold: 4,
    excluded_dirs: ['Thumbs', 'raw-rejects', '2024/Juli/Ausflug'],
    created_at: '2024-06-01T08:00:00Z',
    last_scan_at: '2024-06-05T14:00:00Z',
    active_scan: null,
  },
  {
    id: 2,
    user_id: 1,
    name: 'Familie archiv',
    path: 'Archiv/Familie',
    import_mode: 'move',
    auto_import: false,
    auto_albums: false,
    favorite_rating_threshold: 4,
    excluded_dirs: [],
    created_at: '2024-04-15T08:00:00Z',
    last_scan_at: null,
    active_scan: null,
  },
]

export const MOCK_AVAILABLE_PATHS: AvailablePathsResponse = {
  root: '/photos/libraries',
  root_mounted: true,
  sub: '',
  abs_path: '/photos/libraries',
  current_registered: false,
  current_mounted: true,
  directories: [
    { name: 'Urlaub',   rel_path: 'Urlaub',   abs_path: '/photos/libraries/Urlaub',   already_registered: false, mounted: true },
    { name: 'Archiv',   rel_path: 'Archiv',   abs_path: '/photos/libraries/Archiv',   already_registered: false, mounted: true },
    { name: 'Natur',    rel_path: 'Natur',    abs_path: '/photos/libraries/Natur',    already_registered: false, mounted: false },
  ],
}

// ── Scan Queue & Service Health ───────────────────────────────────────────────

export const MOCK_SCAN_QUEUE_IDLE: ScanQueueStatus = {
  services: [
    { service: 'embedding',      pending: 0, processing: 0, failed: 0, done: 1240 },
    { service: 'face_detection', pending: 0, processing: 0, failed: 0, done: 1240 },
    { service: 'landmark',       pending: 0, processing: 0, failed: 0, done: 1240 },
  ],
}

export const MOCK_SCAN_QUEUE_BUSY: ScanQueueStatus = {
  services: [
    { service: 'embedding',      pending: 42, processing: 3, failed: 1, done: 980 },
    { service: 'face_detection', pending: 23, processing: 2, failed: 0, done: 1010 },
    { service: 'landmark',       pending: 11, processing: 1, failed: 2, done: 1005 },
  ],
}

export const MOCK_SERVICES_OK: ExternalServiceHealth[] = [
  { name: 'insightface', available: true, lastChecked: '2024-06-05T15:00:00Z', lastError: null },
  { name: 'embedding',   available: true, lastChecked: '2024-06-05T15:00:00Z', lastError: null },
]

export const MOCK_SERVICES_DEGRADED: ExternalServiceHealth[] = [
  { name: 'insightface', available: false, lastChecked: '2024-06-05T15:00:00Z', lastError: 'Connection refused' },
  { name: 'embedding',   available: true,  lastChecked: '2024-06-05T15:00:00Z', lastError: null },
]

export const MOCK_SERVER_PRESSURE_OK: ServerPressureStatus = {
  underPressure: false,
  eventLoopLagMs: 4,
}

export const MOCK_SERVER_PRESSURE_HIGH: ServerPressureStatus = {
  underPressure: true,
  eventLoopLagMs: 180,
}

// ── Documents ─────────────────────────────────────────────────────────────────

export const MOCK_DOCUMENT_CATEGORIES: DocumentCategory[] = [
  { id: 1, slug: 'finanzen',        name: 'Finanzen',        parent_id: null, icon: 'pi pi-euro',        sort_order: 1 },
  { id: 2, slug: 'rechnungen',      name: 'Rechnungen',      parent_id: 1,    icon: 'pi pi-receipt',     sort_order: 2 },
  { id: 3, slug: 'versicherungen',  name: 'Versicherungen',  parent_id: null, icon: 'pi pi-shield',      sort_order: 3 },
  { id: 4, slug: 'behoerden',       name: 'Behörden',        parent_id: null, icon: 'pi pi-building',    sort_order: 4 },
  { id: 5, slug: 'vertraege',       name: 'Verträge',        parent_id: null, icon: 'pi pi-file-edit',   sort_order: 5 },
  { id: 6, slug: 'medizin',         name: 'Medizin',         parent_id: null, icon: 'pi pi-heart',       sort_order: 6 },
]

export const MOCK_DOCUMENTS: DocumentSummary[] = [
  {
    id: 1,
    title: 'Stromrechnung März 2024',
    original_filename: 'strom_rechnung_2024-03.pdf',
    mime_type: 'application/pdf',
    size_bytes: 184_320,
    status: 'ready',
    uploaded_at: '2024-03-28T09:15:00Z',
    doc_date: '2024-03-15',
    sender: 'Stadtwerke München',
    document_number: 'R-2024-03-001',
    category_id: 2,
    category_slug: 'rechnungen',
    classification_confidence: 0.94,
    tags: ['Strom', 'Rechnung', '2024', 'SWM'],
    tax_relevant: false,
    tax_year: null,
    last_error: null,
    visibility: 'private',
    group_id: null,
    notes: null,
  },
  {
    id: 2,
    title: 'Hausratversicherung Police',
    original_filename: 'hausrat_police_2024.pdf',
    mime_type: 'application/pdf',
    size_bytes: 512_000,
    status: 'ready',
    uploaded_at: '2024-02-10T14:00:00Z',
    doc_date: '2024-02-01',
    sender: 'Allianz Versicherung',
    document_number: 'P-8827456',
    category_id: 3,
    category_slug: 'versicherungen',
    classification_confidence: 0.88,
    tags: ['Police', 'Hausrat'],
    tax_relevant: false,
    tax_year: null,
    last_error: null,
    visibility: 'private',
    group_id: null,
    notes: null,
  },
  {
    id: 3,
    title: null,
    original_filename: 'finanzamt_bescheid.pdf',
    mime_type: 'application/pdf',
    size_bytes: 245_760,
    status: 'classifying',
    uploaded_at: '2024-06-01T16:20:00Z',
    doc_date: null,
    sender: null,
    document_number: null,
    category_id: null,
    category_slug: null,
    classification_confidence: null,
    tags: [],
    tax_relevant: false,
    tax_year: null,
    last_error: null,
    visibility: 'private',
    group_id: null,
    notes: null,
  },
  {
    id: 4,
    title: null,
    original_filename: 'scan_0042.pdf',
    mime_type: 'application/pdf',
    size_bytes: 98_304,
    status: 'failed',
    uploaded_at: '2024-05-30T08:00:00Z',
    doc_date: null,
    sender: null,
    document_number: null,
    category_id: null,
    category_slug: null,
    classification_confidence: null,
    tags: [],
    tax_relevant: false,
    tax_year: null,
    last_error: 'OCR fehlgeschlagen: Text-Layer konnte nicht extrahiert werden (tesseract: page 1 segmentation failed).',
    visibility: 'private',
    group_id: null,
    notes: null,
  },
  {
    id: 5,
    title: 'Mietvertrag Wohnung',
    original_filename: 'mietvertrag_2023.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1_048_576,
    status: 'ready',
    uploaded_at: '2023-09-01T10:00:00Z',
    doc_date: '2023-08-15',
    sender: 'Immobilien GmbH',
    document_number: 'MV-2023-4711',
    category_id: 5,
    category_slug: 'vertraege',
    classification_confidence: 0.97,
    tags: ['Miete', 'Wohnung', 'Vertrag'],
    tax_relevant: false,
    tax_year: null,
    last_error: null,
    visibility: 'private',
    group_id: null,
    notes: null,
  },
]

export const MOCK_DOCUMENT_DETAIL: DocumentDetail = {
  ...MOCK_DOCUMENTS[0]!,
  summary:
    'Monatliche Stromrechnung der Stadtwerke München für März 2024 über 98,40 EUR. Fällig am 10.04.2024. Kundennummer 123456.',
  extracted_text_preview:
    'STADTWERKE MÜNCHEN GmbH\nRechnung Nr. 2024-03-1156\nKunden-Nr.: 123456\nAbrechnungszeitraum: 01.03.2024 - 31.03.2024\nVerbrauch: 312 kWh\nGesamtbetrag: 98,40 EUR\n\nBitte überweisen Sie den Betrag bis zum 10.04.2024...',
  tax_reviewed: false,
  tax_year_confidence: null,
  tax_sections: [],
  attributes_reviewed: false,
  subject_persons: [],
}

export const MOCK_DOCUMENT_DETAIL_CLASSIFYING: DocumentDetail = {
  ...MOCK_DOCUMENTS[2]!,
  summary: null,
  extracted_text_preview: null,
  tax_reviewed: false,
  tax_year_confidence: null,
  tax_sections: [],
  attributes_reviewed: false,
  subject_persons: [],
}

export const MOCK_DOCUMENT_DETAIL_FAILED: DocumentDetail = {
  ...MOCK_DOCUMENTS[3]!,
  summary: null,
  extracted_text_preview: null,
  tax_reviewed: false,
  tax_year_confidence: null,
  tax_sections: [],
  attributes_reviewed: false,
  subject_persons: [],
}

export const MOCK_DOCUMENT_QUEUE_IDLE: DocumentQueueStatus = {
  services: [
    { service: 'text_extract', pending: 0, processing: 0, failed: 0, done: 120 },
    { service: 'classify',     pending: 0, processing: 0, failed: 0, done: 120 },
    { service: 'embed',        pending: 0, processing: 0, failed: 0, done: 120 },
  ],
}

export const MOCK_DOCUMENT_QUEUE_BUSY: DocumentQueueStatus = {
  services: [
    { service: 'text_extract', pending: 4, processing: 2, failed: 0, done: 114 },
    { service: 'classify',     pending: 5, processing: 1, failed: 1, done: 113 },
    { service: 'embed',        pending: 0, processing: 0, failed: 0, done: 120 },
  ],
}
