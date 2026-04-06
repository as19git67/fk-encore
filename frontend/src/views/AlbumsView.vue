<script setup lang="ts">
import {onMounted, ref, computed, watch, nextTick} from 'vue'
import {useRouter} from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Select from 'primevue/select'
import HeicImage from '../components/HeicImage.vue'
import {
  type Album,
  type AlbumShareWithUser,
  type AlbumPublicLink,
  type PublicLinkExpiry,
  createAlbum, listAlbums, getPhotoUrl, updateAlbum, deleteAlbum,
  getAlbumShares, shareAlbum, removeAlbumShare,
  createAlbumPublicLink, deleteAlbumPublicLink,
} from '../api/photos'
import { listUsers, type UserWithRoles } from '../api/users'
import { useAuthStore } from '../stores/auth'
import ServiceStatusBar from "../components/ServiceStatusBar.vue";

const albums = ref<Album[]>([])
const loading = ref(true)
const error = ref('')
const auth = useAuthStore()

const firstAlbumRef = ref<HTMLElement | null>(null)

const sortedAlbums = computed(() => {
  return [...albums.value].sort((a, b) => {
    const dateA = a.newest_photo_at ? new Date(a.newest_photo_at).getTime() : 0
    const dateB = b.newest_photo_at ? new Date(b.newest_photo_at).getTime() : 0

    if (dateA !== dateB) {
      return dateB - dateA // Newest first
    }

    return a.name.localeCompare(b.name)
  })
})

watch(loading, (newLoading) => {
  if (!newLoading && sortedAlbums.value.length > 0) {
    nextTick(() => {
      firstAlbumRef.value?.focus()
    })
  }
})

const showCreateDialog = ref(false)
const newAlbumName = ref('')
const newAlbumDesc = ref('')
const newAlbumDisplayMode = ref<'grid' | 'map'>('grid')
const creating = ref(false)
const showRenameDialog = ref(false)
const showDeleteDialog = ref(false)
const renameValue = ref('')
const renameDisplayMode = ref<'grid' | 'map'>('grid')
const updatingAlbum = ref(false)
const selectedAlbum = ref<Album | null>(null)

const displayModeOptions = [
  { label: 'Raster', value: 'grid' },
  { label: 'Karte', value: 'map' },
]

const router = useRouter()

async function loadData() {
  loading.value = true
  try {
    const res = await listAlbums()
    albums.value = res.albums
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Alben'
  } finally {
    loading.value = false
  }
}

async function handleCreateAlbum() {
  if (!newAlbumName.value.trim()) return
  creating.value = true
  try {
    const album = await createAlbum(newAlbumName.value.trim(), newAlbumDesc.value.trim() || undefined, newAlbumDisplayMode.value)
    showCreateDialog.value = false
    newAlbumName.value = ''
    newAlbumDesc.value = ''
    newAlbumDisplayMode.value = 'grid'
    await loadData()
    router.push(`/albums/${album.id}`)
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Erstellen des Albums'
  } finally {
    creating.value = false
  }
}

function canManageAlbum(album: Album) {
  return auth.user?.id === album.user_id
}

function openRenameDialog(album: Album) {
  selectedAlbum.value = album
  renameValue.value = album.name
  renameDisplayMode.value = album.display_mode ?? 'grid'
  showRenameDialog.value = true
}

function openDeleteDialog(album: Album) {
  selectedAlbum.value = album
  showDeleteDialog.value = true
}

async function handleRenameAlbum() {
  if (!selectedAlbum.value) return
  const newName = renameValue.value.trim()
  if (!newName) return

  updatingAlbum.value = true
  try {
    await updateAlbum(selectedAlbum.value.id, { name: newName, displayMode: renameDisplayMode.value })
    showRenameDialog.value = false
    selectedAlbum.value = null
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Umbenennen des Albums'
  } finally {
    updatingAlbum.value = false
  }
}

async function handleDeleteAlbum() {
  if (!selectedAlbum.value) return

  updatingAlbum.value = true
  try {
    await deleteAlbum(selectedAlbum.value.id)
    showDeleteDialog.value = false
    selectedAlbum.value = null
    await loadData()
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Löschen des Albums'
  } finally {
    updatingAlbum.value = false
  }
}

// ── Album sharing ─────────────────────────────────────────────────────────────
const showShareDialog = ref(false)
const shareAlbumId = ref<number>(0)
const albumSharesList = ref<AlbumShareWithUser[]>([])
const allUsers = ref<UserWithRoles[]>([])
const shareUserId = ref<number | null>(null)
const shareAccessLevel = ref<'read' | 'write'>('read')
const sharing = ref(false)
const loadingShares = ref(false)
const publicLink = ref<AlbumPublicLink | null>(null)
const linkCopied = ref(false)
const linkExpiry = ref<string | null>(null)
const expiryOptions = [
  { label: 'Unbegrenzt', value: null },
  { label: '7 Tage', value: '7d' },
  { label: '30 Tage', value: '30d' },
  { label: '90 Tage', value: '90d' },
]
const accessLevelOptions = [{ label: 'Nur lesen', value: 'read' }, { label: 'Bearbeiten', value: 'write' }]

const usersNotShared = computed(() => {
  const sharedIds = new Set(albumSharesList.value.map(s => s.user_id))
  const currentUserId = auth.user?.id
  return allUsers.value.filter(u => u.id !== currentUserId && !sharedIds.has(u.id))
})

async function openShareDialog(album: Album) {
  shareAlbumId.value = album.id
  showShareDialog.value = true
  loadingShares.value = true
  try {
    const [sharesRes, usersRes] = await Promise.all([
      getAlbumShares(album.id),
      auth.hasPermission('users.list') ? listUsers() : Promise.resolve({ users: [] }),
    ])
    albumSharesList.value = sharesRes.shares
    publicLink.value = sharesRes.publicLink ?? null
    allUsers.value = usersRes.users
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden der Freigaben'
  } finally {
    loadingShares.value = false
  }
}

async function handleShare() {
  if (!shareUserId.value) return
  sharing.value = true
  try {
    await shareAlbum(shareAlbumId.value, shareUserId.value, shareAccessLevel.value)
    albumSharesList.value = (await getAlbumShares(shareAlbumId.value)).shares
    shareUserId.value = null
    shareAccessLevel.value = 'read'
  } catch (err: any) { error.value = err.message || 'Fehler beim Freigeben' }
  finally { sharing.value = false }
}

async function handleRemoveShare(userId: number) {
  try {
    await removeAlbumShare(shareAlbumId.value, userId)
    albumSharesList.value = albumSharesList.value.filter(s => s.user_id !== userId)
  } catch (err: any) { error.value = err.message || 'Fehler' }
}

function getPublicLinkUrl() {
  if (!publicLink.value) return ''
  return `${window.location.origin}${import.meta.env.BASE_URL}albums/shared/${publicLink.value.token}`
}

async function handleCreatePublicLink() {
  try {
    publicLink.value = await createAlbumPublicLink(shareAlbumId.value, (linkExpiry.value as PublicLinkExpiry) ?? undefined)
    await copyPublicLink()
  } catch (err: any) { error.value = err.message || 'Fehler beim Erstellen des Links' }
}

async function handleDeletePublicLink() {
  try {
    await deleteAlbumPublicLink(shareAlbumId.value)
    publicLink.value = null
    linkCopied.value = false
  } catch (err: any) { error.value = err.message || 'Fehler beim Löschen des Links' }
}

async function copyPublicLink() {
  try {
    await navigator.clipboard.writeText(getPublicLinkUrl())
    linkCopied.value = true
    setTimeout(() => { linkCopied.value = false }, 2000)
  } catch { /* clipboard not available */ }
}

function formatExpiryDate(dateStr: string): string {
  const date = new Date(dateStr)
  if (date < new Date()) return 'Abgelaufen'
  return `Gültig bis ${date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}`
}

const isLinkExpired = computed(() => {
  if (!publicLink.value?.expires_at) return false
  return new Date(publicLink.value.expires_at) < new Date()
})

onMounted(loadData)
</script>

<template>
  <div class="albums-view">

    <!-- Service status warning bar -->
    <ServiceStatusBar />

    <div class="subheader">
      <div class="header">
        <h1 class="title">Meine Alben</h1>
        <Button label="Neues Album" icon="pi pi-plus" @click="showCreateDialog = true"/>
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner"/> Alben werden geladen…
    </div>
    <div v-else-if="albums.length === 0" class="info-text">
      Keine Alben vorhanden. Erstelle dein erstes Album!
    </div>

    <div v-else class="albums-grid">
      <div
          v-for="(album, index) in sortedAlbums"
          :key="album.id"
          :ref="el => { if (index === 0) firstAlbumRef = (el as HTMLElement) }"
          class="album-card"
          tabindex="0"
          @click="router.push(`/albums/${album.id}`)"
          @keydown.enter="router.push(`/albums/${album.id}`)"
          @keydown.space.prevent="router.push(`/albums/${album.id}`)"
      >
        <div v-if="canManageAlbum(album)" class="album-actions" @click.stop>
          <Button icon="pi pi-share-alt" text rounded size="small" v-tooltip="'Freigeben'" @click="openShareDialog(album)" />
          <Button icon="pi pi-pencil" text rounded size="small" v-tooltip="'Bearbeiten'" @click="openRenameDialog(album)" />
          <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip="'Löschen'" @click="openDeleteDialog(album)" />
        </div>
        <div class="album-cover">
          <HeicImage
            v-if="album.cover_filename"
            :src="getPhotoUrl(album.cover_filename, 400)"
            :alt="album.name"
            objectFit="cover"
          />
          <div v-else class="album-icon"><i class="pi pi-images"/></div>
        </div>
        <i v-if="album.is_shared" class="pi pi-share-alt shared-badge" v-tooltip="'Freigegeben'" />
        <div class="album-info">
          <span class="album-name">{{ album.name }}</span>
          <span v-if="album.description" class="album-desc">{{ album.description }}</span>
          <span class="album-meta">
            {{ album.photo_count }} {{ album.photo_count === 1 ? 'Foto' : 'Fotos' }}
            <template v-if="album.oldest_photo_at && album.newest_photo_at">
              • {{ new Date(album.oldest_photo_at).toLocaleDateString() }} - {{ new Date(album.newest_photo_at).toLocaleDateString() }}
            </template>
          </span>
        </div>
      </div>
    </div>

    <Dialog v-model:visible="showCreateDialog" header="Neues Album erstellen" :modal="true">
      <div class="dialog-content">
        <label for="albumName">Name des Albums</label>
        <InputText id="albumName" v-model="newAlbumName" autofocus @keydown.enter="handleCreateAlbum"/>
      </div>
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label for="albumDesc">Beschreibung</label>
        <textarea id="albumDesc" v-model="newAlbumDesc" rows="2" class="p-inputtextarea p-inputtext" style="width: 100%"></textarea>
      </div>
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label>Darstellung</label>
        <SelectButton v-model="newAlbumDisplayMode" :options="displayModeOptions" optionLabel="label" optionValue="value" :allowEmpty="false" />
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showCreateDialog = false"/>
        <Button label="Erstellen" :loading="creating" @click="handleCreateAlbum"/>
      </template>
    </Dialog>

    <Dialog v-model:visible="showRenameDialog" header="Album bearbeiten" :modal="true">
      <div class="dialog-content">
        <label for="renameAlbumName">Name des Albums</label>
        <InputText id="renameAlbumName" v-model="renameValue" autofocus @keydown.enter="handleRenameAlbum" />
      </div>
      <div class="dialog-content" style="margin-top: 0.5rem">
        <label>Darstellung</label>
        <SelectButton v-model="renameDisplayMode" :options="displayModeOptions" optionLabel="label" optionValue="value" :allowEmpty="false" />
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showRenameDialog = false" />
        <Button label="Speichern" :disabled="!renameValue.trim()" :loading="updatingAlbum" @click="handleRenameAlbum" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showDeleteDialog" header="Album löschen" :modal="true" style="width: min(100%, 28rem)">
      <div class="dialog-body">
        <p>Willst du dieses Album wirklich löschen?</p>
        <p class="muted">Es werden keine Fotos gelöscht. Sie bleiben unter <b>Alle Fotos</b> erhalten.</p>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showDeleteDialog = false" />
        <Button label="Löschen" severity="danger" :loading="updatingAlbum" @click="handleDeleteAlbum" />
      </template>
    </Dialog>

    <!-- Share Dialog -->
    <Dialog v-model:visible="showShareDialog" header="Album freigeben" modal style="width: 480px">
      <div v-if="loadingShares" class="share-loading"><i class="pi pi-spin pi-spinner" /> Lädt…</div>
      <template v-else>
        <div class="share-section">
          <h4 class="share-section-title"><i class="pi pi-link" /> Öffentlicher Link</h4>
          <div v-if="publicLink" class="public-link-block">
            <div class="public-link-row">
              <input :value="getPublicLinkUrl()" readonly class="p-inputtext public-link-input" @focus="($event.target as HTMLInputElement).select()" />
              <Button :icon="linkCopied ? 'pi pi-check' : 'pi pi-copy'" :severity="linkCopied ? 'success' : 'secondary'" size="small" v-tooltip="'Kopieren'" @click="copyPublicLink" />
              <Button icon="pi pi-trash" size="small" text severity="danger" v-tooltip="'Link löschen'" @click="handleDeletePublicLink" />
            </div>
            <div class="public-link-meta">
              <span v-if="publicLink.expires_at" :class="['public-link-expiry', { 'public-link-expiry--expired': isLinkExpired }]">
                <i :class="isLinkExpired ? 'pi pi-exclamation-circle' : 'pi pi-clock'" />
                {{ formatExpiryDate(publicLink.expires_at) }}
              </span>
              <span v-else class="public-link-expiry">
                <i class="pi pi-clock" /> Unbegrenzt gültig
              </span>
            </div>
          </div>
          <div v-else class="public-link-create">
            <div class="public-link-create-row">
              <Select v-model="linkExpiry" :options="expiryOptions" optionLabel="label" optionValue="value" placeholder="Gültigkeit" class="link-expiry-select" />
              <Button label="Link erstellen" icon="pi pi-link" size="small" outlined @click="handleCreatePublicLink" />
            </div>
            <span class="share-hint">Jeder mit dem Link kann das Album ansehen.</span>
          </div>
        </div>

        <div class="share-section">
          <h4 class="share-section-title">Aktuelle Freigaben</h4>
          <div v-if="albumSharesList.length === 0" class="share-empty">Noch keine Freigaben.</div>
          <div v-for="share in albumSharesList" :key="share.user_id" class="share-row">
            <div class="share-user-info">
              <span class="share-user-name">{{ share.user_name }}</span>
              <span class="share-user-email">{{ share.user_email }}</span>
            </div>
            <span :class="['share-badge', share.access_level === 'write' ? 'share-badge--write' : 'share-badge--read']">
              {{ share.access_level === 'write' ? 'Bearbeiten' : 'Nur lesen' }}
            </span>
            <Button icon="pi pi-times" size="small" text severity="danger" @click="handleRemoveShare(share.user_id)" />
          </div>
        </div>
        <div class="share-section">
          <h4 class="share-section-title">Benutzer hinzufügen</h4>
          <div class="share-add-form">
            <Select v-if="allUsers.length > 0" v-model="shareUserId" :options="usersNotShared" optionLabel="name" optionValue="id" placeholder="Benutzer auswählen…" class="share-user-select" />
            <input v-else v-model.number="shareUserId" type="number" placeholder="Benutzer-ID" class="p-inputtext share-userid-input" />
            <SelectButton v-model="shareAccessLevel" :options="accessLevelOptions" optionLabel="label" optionValue="value" />
            <Button label="Freigeben" icon="pi pi-check" :loading="sharing" :disabled="!shareUserId" @click="handleShare" />
          </div>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.dialog-content {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5em;
}

.albums-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--menubar-height, 3.5rem));
  overflow-y: auto;
  margin-inline: -0.25em;
  padding-inline: 0.5em;
  width: 100%;
}

@media (min-width: 800px) {
  .albums-view {
    margin-inline: -0.5em;
    padding-inline: 1em;
  }
}

.albums-view .title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-block: 0.25rem;
  margin-bottom: 1rem;
}

.albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.album-card {
  position: relative;
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: 0;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.shared-badge {
  position: absolute;
  bottom: 0.5rem;
  right: 0.5rem;
  z-index: 1;
  font-size: 0.9rem;
  color: white;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 50%;
  padding: 0.35rem;
  backdrop-filter: blur(4px);
}

.album-actions {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 1;
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--p-surface-card) 82%, transparent);
  backdrop-filter: blur(4px);
}

.album-card:hover,
.album-card:focus-visible {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.album-cover {
  width: 100%;
  height: 200px;
  background: var(--p-content-hover-background);
  overflow: hidden;
}
.album-cover :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
}
.album-icon {
  font-size: 3rem;
  color: var(--p-primary-color);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.album-info {
  padding: 0.75rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.album-name {
  font-weight: 600;
  display: block;
}
.album-desc {
  font-size: 0.9rem;
  color: var(--p-text-muted-color);
}

.album-meta {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

/* ── Share dialog ────────────────────────────────────────────────────────── */
.share-loading { padding: 1rem; text-align: center; }
.share-section { margin-bottom: 1.5rem; }
.share-section-title { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.75rem; }
.share-empty { font-size: 0.85rem; color: var(--p-text-muted-color); }
.share-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.4rem 0; border-bottom: 1px solid var(--p-content-border-color); }
.share-user-info { flex: 1; min-width: 0; }
.share-user-name { display: block; font-size: 0.875rem; font-weight: 500; }
.share-user-email { display: block; font-size: 0.75rem; color: var(--p-text-muted-color); }
.share-badge { font-size: 0.7rem; padding: 0.15rem 0.4rem; border-radius: 3px; white-space: nowrap; }
.share-badge--read { background: var(--p-content-border-color); color: var(--p-text-muted-color); }
.share-badge--write { background: var(--p-green-100); color: var(--p-green-700); }
.share-add-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.share-user-select { flex: 1; min-width: 180px; }
.share-userid-input { width: 120px; }
.share-hint { font-size: 0.8rem; color: var(--p-text-muted-color); margin-top: 0.4rem; display: block; }
.public-link-block { display: flex; flex-direction: column; gap: 0.4rem; }
.public-link-row { display: flex; gap: 0.5rem; align-items: center; }
.public-link-input { flex: 1; font-size: 0.8rem; }
.public-link-meta { display: flex; align-items: center; gap: 0.5rem; }
.public-link-expiry { font-size: 0.8rem; color: var(--p-text-muted-color); display: flex; align-items: center; gap: 0.3rem; }
.public-link-expiry--expired { color: var(--p-red-500, #ef4444); font-weight: 500; }
.public-link-create { display: flex; flex-direction: column; gap: 0.4rem; }
.public-link-create-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.link-expiry-select { min-width: 140px; }
</style>
