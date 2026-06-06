<script setup lang="ts">
import { onMounted, onBeforeUnmount, nextTick, ref } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import PhotoFeedCard from '../components/PhotoFeedCard.vue'
import FeedUploadAlbumDialog from '../components/FeedUploadAlbumDialog.vue'
import { listPhotoFeed, type FeedPhotoItem, type PhotoFeedCursor } from '../api/photoFeed'
import { updatePhotoCuration, listAlbums, uploadPhoto, batchUpdateAlbumPhotos, computeFileHash, checkPhotoHash } from '../api/photos'
import { createComment } from '../api/reactions'
import {
  writableAlbums,
  initialAlbumSelection,
  saveLastAlbumSelection,
  type UploadAlbum,
} from '../utils/feedUpload'
import { useRealtimeEvent } from '../composables/useRealtime'
import { useAuthStore } from '../stores/auth'
import { usePhotoFeedStore } from '../stores/photoFeed'

const router = useRouter()
const auth = useAuthStore()
const feedCache = usePhotoFeedStore()

const PAGE_SIZE = 12

const items = ref<FeedPhotoItem[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const error = ref('')
const nextCursor = ref<PhotoFeedCursor | null>(null)
const hasNew = ref(false)

// ── Upload ──────────────────────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const dialogVisible = ref(false)
const dialogAlbums = ref<UploadAlbum[]>([])
const dialogInitial = ref<number[]>([])
const pendingFileCount = ref(0)
let pendingFiles: File[] = []

function pickFiles() {
  fileInput.value?.click()
}

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  // Reset so picking the same file again re-fires change.
  input.value = ''
  if (files.length === 0) return
  void startUpload(files)
}

async function startUpload(files: File[]) {
  error.value = ''
  let albums: UploadAlbum[]
  try {
    const res = await listAlbums()
    albums = writableAlbums(res.albums)
  } catch {
    error.value = 'Alben konnten nicht geladen werden'
    return
  }
  if (albums.length === 0) {
    error.value = 'Du brauchst mindestens ein Album mit Schreibrechten, um Fotos in den Feed hochzuladen.'
    return
  }
  pendingFiles = files
  pendingFileCount.value = files.length
  if (albums.length === 1) {
    // Only one possible target — skip the dialog.
    await doUpload([albums[0]!.id])
    return
  }
  dialogAlbums.value = albums
  dialogInitial.value = initialAlbumSelection(albums)
  dialogVisible.value = true
}

function onDialogConfirm(albumIds: number[]) {
  saveLastAlbumSelection(albumIds)
  dialogVisible.value = false
  void doUpload(albumIds)
}

function onDialogCancel() {
  pendingFiles = []
}

async function doUpload(albumIds: number[]) {
  const files = pendingFiles
  pendingFiles = []
  if (files.length === 0 || albumIds.length === 0) return
  uploading.value = true
  error.value = ''
  const photoIds: number[] = []
  let failed = 0
  for (const file of files) {
    try {
      // Dedup: if the exact bytes already exist in the library, reuse that
      // photo instead of re-uploading — it only needs to join the chosen
      // albums. Mirrors the album-upload flow.
      const hash = await computeFileHash(file)
      if (hash) {
        try {
          const { exists, photoId } = await checkPhotoHash(hash)
          if (exists) {
            if (photoId) photoIds.push(photoId)
            else failed += 1
            continue
          }
        } catch {
          // Pre-check failure is non-fatal — fall through to a real upload.
        }
      }
      const photo = await uploadPhoto(file)
      photoIds.push(photo.id)
    } catch {
      // Per-file errors (unsupported type, network, an un-resolvable
      // duplicate) are skipped and reported as a count.
      failed += 1
    }
  }
  try {
    if (photoIds.length > 0) {
      // Idempotent: photos already in a target album are left untouched.
      await batchUpdateAlbumPhotos(albumIds, photoIds, 'add')
    }
  } catch {
    error.value = 'Fotos konnten den Alben nicht hinzugefügt werden'
  }
  uploading.value = false
  if (failed > 0) {
    error.value = `${failed} von ${files.length} Foto(s) konnten nicht verarbeitet werden.`
  }
  if (photoIds.length > 0) {
    // The added photos bump our own feed server-side; reload to show them on top.
    await refresh()
  }
}

const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

async function loadInitial() {
  loading.value = true
  error.value = ''
  hasNew.value = false
  try {
    const res = await listPhotoFeed({ limit: PAGE_SIZE })
    items.value = res.items
    nextCursor.value = res.nextCursor
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden des Feeds'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const res = await listPhotoFeed({
      limit: PAGE_SIZE,
      cursorTs: nextCursor.value.ts,
      cursorId: nextCursor.value.id,
    })
    items.value.push(...res.items)
    nextCursor.value = res.nextCursor
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden weiterer Beiträge'
  } finally {
    loadingMore.value = false
  }
}

async function onLike(item: FeedPhotoItem) {
  // Optimistic toggle — favorite is the "like". Revert on failure.
  const wasLiked = item.likedByMe
  item.likedByMe = !wasLiked
  item.likeCount += wasLiked ? -1 : 1
  try {
    await updatePhotoCuration(item.photoId, wasLiked ? 'visible' : 'favorite')
  } catch {
    item.likedByMe = wasLiked
    item.likeCount += wasLiked ? 1 : -1
  }
}

async function onHide(item: FeedPhotoItem) {
  // Thumbs-down toggles the viewer's "hidden" curation. The card stays in
  // place (dimmed) so it can be un-hidden; hidden photos only drop out when
  // the feed is reloaded (the read query excludes them). Optimistic, reverts
  // on failure.
  const wasHidden = !!item.hiddenByMe
  item.hiddenByMe = !wasHidden
  try {
    await updatePhotoCuration(item.photoId, wasHidden ? 'visible' : 'hidden')
  } catch {
    item.hiddenByMe = wasHidden
    error.value = 'Ausblenden fehlgeschlagen'
  }
}

async function onComment(item: FeedPhotoItem, body: string) {
  if (!item.album) return
  try {
    await createComment(item.photoId, body, item.album.id)
    item.commentCount += 1
    item.latestComment = {
      author: auth.user?.name ?? 'Du',
      excerpt: body.slice(0, 140),
    }
  } catch (err: any) {
    error.value = err.message || 'Kommentar konnte nicht gespeichert werden'
  }
}

// Discard the cached page and reload from the top (the "neue Aktivität" pill
// and any forced refresh). Without clearing, restore-on-mount would bring the
// stale page back.
async function refresh() {
  feedCache.clear()
  await loadInitial()
  window.scrollTo({ top: 0 })
}

function onOpen(item: FeedPhotoItem) {
  // `from: 'stream'` lets the album's back button return here instead of the
  // album list. onBeforeRouteLeave snapshots our scroll position first.
  if (item.album) {
    router.push({
      name: 'fotos-album-detail',
      params: { id: item.album.id },
      query: { photoId: item.photoId, from: 'stream' },
    })
  } else {
    router.push({ name: 'fotos-gallery', query: { photoId: item.photoId } })
  }
}

// Live activity: a bump elsewhere may reorder the feed. Rather than yanking
// the user's scroll position, surface a "neue Aktivität" pill they can tap to
// refresh — but only once they're not already at the very top.
useRealtimeEvent('feed', 'photo.changed', () => {
  if (window.scrollY < 200) {
    void refresh()
  } else {
    hasNew.value = true
  }
})

onMounted(async () => {
  if (feedCache.hasCache) {
    // Returning from an album: restore the exact list + scroll position.
    items.value = feedCache.items
    nextCursor.value = feedCache.nextCursor
    loading.value = false
    await nextTick()
    window.scrollTo({ top: feedCache.scrollY })
  } else {
    await loadInitial()
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore()
    },
    { rootMargin: '600px 0px' },
  )
  if (sentinel.value) observer.observe(sentinel.value)
})

// Snapshot the current list + scroll offset on every navigation away so a
// later return restores the user's place.
onBeforeRouteLeave(() => {
  feedCache.save({
    items: items.value,
    nextCursor: nextCursor.value,
    scrollY: window.scrollY,
  })
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <div class="photo-feed">
    <div class="header">
      <h1 class="title">Feed</h1>
      <div class="header-actions">
        <Button
          v-if="hasNew"
          label="Neue Aktivität"
          icon="pi pi-arrow-up"
          size="small"
          rounded
          @click="refresh"
        />
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          multiple
          class="upload-input-hidden"
          @change="onFilesSelected"
        />
        <Button
          icon="pi pi-upload"
          :label="uploading ? 'Lädt…' : 'Hochladen'"
          size="small"
          :loading="uploading"
          :disabled="uploading"
          @click="pickFiles"
        />
      </div>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Feed wird geladen…
    </div>
    <div v-else-if="items.length === 0" class="info-text">
      Noch keine Beiträge. Sobald Fotos zu deinen Alben hinzugefügt oder
      kommentiert werden, erscheinen sie hier — chronologisch, neueste zuerst.
    </div>

    <div v-else class="stream">
      <PhotoFeedCard
        v-for="item in items"
        :key="item.photoId"
        :item="item"
        @like="onLike"
        @hide="onHide"
        @open="onOpen"
        @comment="onComment"
      />
    </div>

    <div ref="sentinel" class="sentinel" />
    <div v-if="loadingMore" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Weitere Beiträge…
    </div>

    <FeedUploadAlbumDialog
      :visible="dialogVisible"
      :albums="dialogAlbums"
      :initial="dialogInitial"
      :fileCount="pendingFileCount"
      @update:visible="(v) => (dialogVisible = v)"
      @confirm="onDialogConfirm"
      @cancel="onDialogCancel"
    />
  </div>
</template>

<style scoped>
.photo-feed {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  max-width: 600px;
  margin-inline: auto;
  padding-inline: 0.5em;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-block: 0.25rem 0.25rem;
}
.title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.upload-input-hidden {
  display: none;
}

.info-text {
  text-align: center;
  margin-top: 2rem;
  color: var(--p-text-muted-color);
}

.stream {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.sentinel {
  height: 1px;
}
</style>
