import { API_BASE_URL, apiFetch, withAuthTokenParam } from './client'

// Haus › Anlagen (documentation/plans/haus-anlagen.md).

export type HomeSystemCategory =
  | 'heating'
  | 'water'
  | 'ventilation'
  | 'sanitary'
  | 'electrical'
  | 'garden'
  | 'building'
  | 'other'

export const HOME_CATEGORY_LABELS: Record<HomeSystemCategory, string> = {
  heating: 'Heizung',
  water: 'Wasser',
  ventilation: 'Lüftung',
  sanitary: 'Sanitär',
  electrical: 'Elektrik',
  garden: 'Garten',
  building: 'Gebäude',
  other: 'Sonstiges',
}

export const HOME_CATEGORY_ICONS: Record<HomeSystemCategory, string> = {
  heating: 'pi pi-sun',
  water: 'pi pi-filter',
  ventilation: 'pi pi-sync',
  sanitary: 'pi pi-inbox',
  electrical: 'pi pi-bolt',
  garden: 'pi pi-sparkles',
  building: 'pi pi-building',
  other: 'pi pi-wrench',
}

export interface HomeItemAttribute {
  key: string
  value: string
}

interface Sharing {
  groupId: number | null
  groupName: string | null
  household: boolean
  ownerUserId: number
  ownerName: string
  /** The caller may change the system itself (data, sharing, delete). */
  canManage: boolean
}

export interface HomeSystemListItem extends Sharing {
  id: number
  name: string
  category: HomeSystemCategory
  location: string | null
  manufacturer: string | null
  model: string | null
  archived: boolean
  guideCount: number
  itemCount: number
  noteCount: number
  lastNoteOn: string | null
  /** Where the search term was found besides the system's own fields. */
  matches: string[]
  /** The first photo of the system itself, shown on its card. */
  coverMediaId: number | null
  updatedAt: string
}

export interface HomeGuide {
  id: number
  title: string
  body: string
  sort: number
  updatedAt: string
  updatedByName: string | null
  revisionCount: number
}

export interface HomeItem {
  id: number
  label: string
  location: string | null
  attributes: HomeItemAttribute[]
  /** The part this unit takes, when the caller sees it. */
  partId: number | null
  partName: string | null
  sort: number
}

export interface HomeNote {
  id: number
  notedOn: string
  body: string
  authorId: number | null
  authorName: string | null
  createdAt: string
  updatedAt: string
}

export type HomeMediaTargetKind = 'system' | 'guide' | 'item' | 'note' | 'part'

export interface HomeMedia {
  id: number
  targetKind: HomeMediaTargetKind
  targetId: number
  caption: string | null
  width: number
  height: number
  createdAt: string
}

export interface HomeSystemDetail extends Sharing {
  id: number
  name: string
  category: HomeSystemCategory
  location: string | null
  manufacturer: string | null
  model: string | null
  installedOn: string | null
  description: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
  guides: HomeGuide[]
  items: HomeItem[]
  notes: HomeNote[]
  /** Photos of the system and of its guides, items and notes, oldest first. */
  media: HomeMedia[]
  /** Spare parts that fit, among the parts the caller sees. */
  parts: HomeSystemPart[]
}

/** A part as the system page lists it. */
export interface HomeSystemPart {
  id: number
  name: string
  manufacturer: string | null
  partNumber: string | null
  specification: string | null
  storageLocation: string | null
  /** null = not counted. */
  stock: number | null
}

export interface GuideRevision {
  id: number
  title: string
  body: string
  editedAt: string
  editedByName: string | null
}

export interface HomeSystemFields {
  name: string
  category: HomeSystemCategory
  location?: string | null
  manufacturer?: string | null
  model?: string | null
  /** `YYYY-MM-DD`. */
  installedOn?: string | null
  description?: string | null
  /** Omitted: the household; null: private. */
  groupId?: number | null
}

export interface HomeShareGroup {
  id: number
  name: string
  household: boolean
}

export function listHomeShareGroups() {
  return apiFetch<{ householdId: number | null; groups: HomeShareGroup[] }>('/home/share-groups')
}

export function listHomeSystems(params: { q?: string; category?: string; archived?: boolean } = {}) {
  const q = new URLSearchParams()
  if (params.q) q.set('q', params.q)
  if (params.category) q.set('category', params.category)
  if (params.archived) q.set('archived', 'true')
  const suffix = q.toString() ? `?${q}` : ''
  return apiFetch<{ systems: HomeSystemListItem[] }>(`/home/systems${suffix}`)
}

export function createHomeSystem(fields: HomeSystemFields) {
  return apiFetch<{ id: number }>('/home/systems', { method: 'POST', body: JSON.stringify(fields) })
}

export function getHomeSystem(id: number) {
  return apiFetch<HomeSystemDetail>(`/home/systems/${id}`)
}

export function updateHomeSystem(id: number, patch: Partial<HomeSystemFields> & { archived?: boolean }) {
  return apiFetch<HomeSystemDetail>(`/home/systems/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteHomeSystem(id: number) {
  return apiFetch<void>(`/home/systems/${id}`, { method: 'DELETE' })
}

export function createHomeGuide(systemId: number, guide: { title: string; body?: string }) {
  return apiFetch<{ id: number }>(`/home/systems/${systemId}/guides`, {
    method: 'POST',
    body: JSON.stringify(guide),
  })
}

export function updateHomeGuide(
  systemId: number,
  guideId: number,
  patch: { title?: string; body?: string; sort?: number },
) {
  return apiFetch<void>(`/home/systems/${systemId}/guides/${guideId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteHomeGuide(systemId: number, guideId: number) {
  return apiFetch<void>(`/home/systems/${systemId}/guides/${guideId}`, { method: 'DELETE' })
}

export function listHomeGuideRevisions(systemId: number, guideId: number) {
  return apiFetch<{ revisions: GuideRevision[] }>(`/home/systems/${systemId}/guides/${guideId}/revisions`)
}

export function restoreHomeGuideRevision(systemId: number, guideId: number, revisionId: number) {
  return apiFetch<void>(`/home/systems/${systemId}/guides/${guideId}/revisions/${revisionId}/restore`, {
    method: 'POST',
  })
}

export interface HomeItemFields {
  label: string
  location?: string | null
  attributes?: HomeItemAttribute[]
  /** The part this unit takes; it is fitted to the system as well. */
  partId?: number | null
}

export function createHomeItem(systemId: number, item: HomeItemFields) {
  return apiFetch<{ id: number }>(`/home/systems/${systemId}/items`, {
    method: 'POST',
    body: JSON.stringify(item),
  })
}

export function updateHomeItem(systemId: number, itemId: number, patch: Partial<HomeItemFields> & { sort?: number }) {
  return apiFetch<void>(`/home/systems/${systemId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteHomeItem(systemId: number, itemId: number) {
  return apiFetch<void>(`/home/systems/${systemId}/items/${itemId}`, { method: 'DELETE' })
}

export function createHomeNote(systemId: number, note: { body: string; notedOn?: string | null }) {
  return apiFetch<{ id: number }>(`/home/systems/${systemId}/notes`, {
    method: 'POST',
    body: JSON.stringify(note),
  })
}

export function updateHomeNote(systemId: number, noteId: number, patch: { body?: string; notedOn?: string | null }) {
  return apiFetch<void>(`/home/systems/${systemId}/notes/${noteId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteHomeNote(systemId: number, noteId: number) {
  return apiFetch<void>(`/home/systems/${systemId}/notes/${noteId}`, { method: 'DELETE' })
}

// ── Photos (stage 2) ────────────────────────────────────────────────────────

/**
 * Upload a photo for the system itself or one of its guides, items or
 * notes. The server turns it upright, shrinks it and drops every metadata
 * field (the camera's location included).
 */
export function uploadHomeMedia(
  systemId: number | null,
  target: { kind: HomeMediaTargetKind; id: number },
  file: Blob,
) {
  const q = new URLSearchParams({ target: target.kind, targetId: String(target.id) })
  // A part's photo belongs to the part, not to a system.
  const path = target.kind === 'part' ? `/home/parts/${target.id}/media` : `/home/systems/${systemId}/media?${q}`
  return apiFetch<HomeMedia>(path, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
  })
}

/** For an `<img src>`: the photo with the access token in the URL. */
export function homeMediaUrl(mediaId: number, size: 'small' | 'full' = 'full'): string {
  return withAuthTokenParam(`${API_BASE_URL}/home/media/${mediaId}/file?size=${size}`)
}

export function updateHomeMediaCaption(mediaId: number, caption: string | null) {
  return apiFetch<HomeMedia>(`/home/media/${mediaId}`, { method: 'PATCH', body: JSON.stringify({ caption }) })
}

export function deleteHomeMedia(mediaId: number) {
  return apiFetch<void>(`/home/media/${mediaId}`, { method: 'DELETE' })
}

// ── Spare parts (stage 3) ───────────────────────────────────────────────────

export interface HomePartSystemRef {
  id: number
  name: string
}

export interface HomePartListItem extends Omit<Sharing, 'canManage'> {
  id: number
  name: string
  manufacturer: string | null
  partNumber: string | null
  specification: string | null
  storageLocation: string | null
  /** null = not counted. */
  stock: number | null
  systems: HomePartSystemRef[]
  coverMediaId: number | null
  updatedAt: string
  /** The caller may share or delete the part. */
  canManage: boolean
}

export interface HomePartItemRef {
  systemId: number
  systemName: string
  itemId: number
  label: string
  location: string | null
}

export interface HomePartDetail extends HomePartListItem {
  ean: string | null
  supplierUrl: string | null
  notes: string | null
  createdAt: string
  items: HomePartItemRef[]
  media: HomeMedia[]
}

export interface HomePartFields {
  name: string
  manufacturer?: string | null
  partNumber?: string | null
  ean?: string | null
  specification?: string | null
  supplierUrl?: string | null
  storageLocation?: string | null
  stock?: number | null
  notes?: string | null
  /** Omitted: the household; null: private. */
  groupId?: number | null
}

export function listHomeParts(params: { q?: string; empty?: boolean; systemId?: number } = {}) {
  const q = new URLSearchParams()
  if (params.q) q.set('q', params.q)
  if (params.empty) q.set('empty', 'true')
  if (params.systemId !== undefined) q.set('systemId', String(params.systemId))
  const suffix = q.toString() ? `?${q}` : ''
  return apiFetch<{ parts: HomePartListItem[] }>(`/home/parts${suffix}`)
}

export function createHomePart(fields: HomePartFields) {
  return apiFetch<{ id: number }>('/home/parts', { method: 'POST', body: JSON.stringify(fields) })
}

export function getHomePart(id: number) {
  return apiFetch<HomePartDetail>(`/home/parts/${id}`)
}

export function updateHomePart(id: number, patch: Partial<HomePartFields>) {
  return apiFetch<HomePartDetail>(`/home/parts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

/** -1 = one taken out, +1 = one put back. Returns the new stock. */
export function adjustHomePartStock(id: number, delta: number) {
  return apiFetch<{ stock: number }>(`/home/parts/${id}/stock`, { method: 'POST', body: JSON.stringify({ delta }) })
}

export function deleteHomePart(id: number) {
  return apiFetch<void>(`/home/parts/${id}`, { method: 'DELETE' })
}

/** Which parts fit a system (parts the caller cannot see stay linked). */
export function setHomeSystemParts(systemId: number, partIds: number[]) {
  return apiFetch<void>(`/home/systems/${systemId}/parts`, { method: 'PUT', body: JSON.stringify({ partIds }) })
}

/** "4 Stück", "keins mehr da", or "nicht gezählt" when nobody counts. */
export function stockLabel(stock: number | null): string {
  if (stock === null) return 'nicht gezählt'
  if (stock === 0) return 'keins mehr da'
  return `${stock} Stück`
}
