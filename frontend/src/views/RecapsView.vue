<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import HeicImage from '../components/HeicImage.vue'
import RecapPlayer from '../components/RecapPlayer.vue'
import {
  listRecaps,
  getRecap,
  getRecapMusicUrl,
  dismissRecap,
  markRecapSeen,
  rebuildRecaps,
  type RecapSummary,
  type RecapDetails,
  type RecapKind,
  type MusicTrack,
} from '../api/recaps'
import {
  getPhotoDetailsBatch,
  getPhotoUrl,
  type Photo,
} from '../api/photos'

const route = useRoute()
const router = useRouter()

const recaps = ref<RecapSummary[]>([])
const loading = ref(true)
const error = ref('')
const rebuilding = ref(false)
const coverFilenames = ref<Record<number, string>>({})

const activeRecapId = computed(() => {
  const raw = route.query.id
  if (typeof raw !== 'string') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
})

const detail = ref<RecapDetails | null>(null)
const detailMusic = ref<MusicTrack | null>(null)
const detailPhotos = ref<Photo[]>([])
const detailLoading = ref(false)
const detailError = ref('')
const playerOpen = ref(false)
const playerPhotos = ref<Photo[]>([])
const playerTitle = ref<string>('')
const playerSubtitle = ref<string | null>(null)
const playerMusicUrl = ref<string | null>(null)
const cardPlayLoadingId = ref<number | null>(null)

const kindLabels: Record<RecapKind, string> = {
  on_this_day: 'Heute vor…',
  trip: 'Reise',
  person: 'Person',
  place: 'Ort',
  theme: 'Thema',
  recent_highlights: 'Kürzlich',
}

async function loadList() {
  loading.value = true
  error.value = ''
  try {
    const res = await listRecaps()
    recaps.value = res.recaps
    const ids = Array.from(
      new Set(
        res.recaps
          .map((r) => r.cover_photo_id)
          .filter((id): id is number => typeof id === 'number')
      )
    )
    if (ids.length > 0) {
      const details = await getPhotoDetailsBatch(ids)
      const map: Record<number, string> = {}
      for (const p of details.photos) map[p.id] = p.filename
      coverFilenames.value = map
    } else {
      coverFilenames.value = {}
    }
  } catch (err: any) {
    error.value = err?.message ?? 'Rückblicke konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

async function loadDetail(id: number) {
  detailLoading.value = true
  detailError.value = ''
  detail.value = null
  detailPhotos.value = []
  try {
    const res = await getRecap(id)
    detail.value = res.recap
    detailMusic.value = res.music ?? null
    if (res.recap.photo_ids.length > 0) {
      const photosRes = await getPhotoDetailsBatch(res.recap.photo_ids)
      const byId = new Map(photosRes.photos.map((p) => [p.id, p]))
      detailPhotos.value = res.recap.photo_ids
        .map((pid) => byId.get(pid))
        .filter((p): p is Photo => !!p)
    }
    // Opening the detail counts as "seen". Fire-and-forget; a failed
    // stamp is harmless — the badge just stays until the next rebuild.
    if (!res.recap.seen_at) {
      const stamp = new Date().toISOString()
      markRecapSeen(id).catch(() => {})
      const summary = recaps.value.find((r) => r.id === id)
      if (summary) summary.seen_at = stamp
    }
  } catch (err: any) {
    detailError.value = err?.message ?? 'Rückblick konnte nicht geladen werden.'
  } finally {
    detailLoading.value = false
  }
}

function openRecap(id: number) {
  router.push({ path: route.path, query: { ...route.query, id: String(id) } })
}

function closeDetail() {
  const { id: _omit, ...rest } = route.query
  router.push({ path: route.path, query: rest })
}

async function handleDismiss(recap: RecapSummary) {
  if (!confirm(`Rückblick „${recap.title}“ ausblenden?`)) return
  try {
    await dismissRecap(recap.id)
    recaps.value = recaps.value.filter((r) => r.id !== recap.id)
    if (activeRecapId.value === recap.id) closeDetail()
  } catch (err: any) {
    error.value = err?.message ?? 'Ausblenden fehlgeschlagen.'
  }
}

async function handleRebuild() {
  rebuilding.value = true
  try {
    await rebuildRecaps()
    await loadList()
  } catch (err: any) {
    error.value = err?.message ?? 'Aktualisierung fehlgeschlagen.'
  } finally {
    rebuilding.value = false
  }
}

function coverUrl(photoId: number | null, size = 600): string | null {
  if (!photoId) return null
  const filename = coverFilenames.value[photoId]
  if (!filename) return null
  return getPhotoUrl(filename, size)
}

onMounted(loadList)

watch(
  activeRecapId,
  (id) => {
    if (id != null) loadDetail(id)
    else {
      detail.value = null
      detailMusic.value = null
      detailPhotos.value = []
      playerOpen.value = false
    }
  },
  { immediate: true }
)

function openPlayer() {
  if (detailPhotos.value.length === 0) return
  playerPhotos.value = detailPhotos.value
  playerTitle.value = detail.value?.title ?? ''
  playerSubtitle.value = detail.value?.subtitle ?? null
  playerMusicUrl.value = detailMusic.value ? getRecapMusicUrl(detailMusic.value) : null
  playerOpen.value = true
}

async function playFromCard(r: RecapSummary, e: Event) {
  e.stopPropagation()
  if (cardPlayLoadingId.value != null) return
  cardPlayLoadingId.value = r.id
  try {
    const res = await getRecap(r.id)
    if (res.recap.photo_ids.length === 0) return
    const photosRes = await getPhotoDetailsBatch(res.recap.photo_ids)
    const byId = new Map(photosRes.photos.map((p) => [p.id, p]))
    playerPhotos.value = res.recap.photo_ids
      .map((pid) => byId.get(pid))
      .filter((p): p is Photo => !!p)
    playerTitle.value = res.recap.title
    playerSubtitle.value = res.recap.subtitle ?? null
    playerMusicUrl.value = res.music ? getRecapMusicUrl(res.music) : null
    playerOpen.value = true
    if (!res.recap.seen_at) {
      const stamp = new Date().toISOString()
      markRecapSeen(r.id).catch(() => {})
      const summary = recaps.value.find((s) => s.id === r.id)
      if (summary) summary.seen_at = stamp
    }
  } catch (err: any) {
    error.value = err?.message ?? 'Rückblick konnte nicht gestartet werden.'
  } finally {
    cardPlayLoadingId.value = null
  }
}
</script>

<template>
  <div class="recaps-view">
    <header class="recaps-header">
      <h1>Rückblicke</h1>
      <Button
        icon="pi pi-refresh"
        label="Aktualisieren"
        severity="secondary"
        :loading="rebuilding"
        @click="handleRebuild"
      />
    </header>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-if="loading" class="recaps-empty">Lade Rückblicke …</div>

    <div v-else-if="recaps.length === 0" class="recaps-empty">
      <p>Noch keine Rückblicke.</p>
      <p class="hint">
        Rückblicke entstehen automatisch aus Deinen Fotos. Sobald Du Fotos mit
        Datum und Ort hast, erscheinen hier Erinnerungen an vergangene Tage und
        Reisen.
      </p>
    </div>

    <div v-else class="recaps-grid">
      <div
        v-for="r in recaps"
        :key="r.id"
        class="recap-card"
        role="button"
        tabindex="0"
        @click="openRecap(r.id)"
        @keydown.enter="openRecap(r.id)"
      >
        <div class="recap-cover">
          <HeicImage
            v-if="coverUrl(r.cover_photo_id, 600)"
            :src="coverUrl(r.cover_photo_id, 600) as string"
            alt=""
          />
          <div v-else class="recap-cover-fallback">
            <i class="pi pi-images" />
          </div>
          <span class="recap-kind-badge">{{ kindLabels[r.kind] }}</span>
          <span v-if="!r.seen_at" class="recap-new-badge">Neu</span>
          <button
            type="button"
            class="recap-card-play"
            :aria-label="`Rückblick „${r.title}“ abspielen`"
            :disabled="cardPlayLoadingId != null"
            @click.stop="playFromCard(r, $event)"
          >
            <i :class="cardPlayLoadingId === r.id ? 'pi pi-spin pi-spinner' : 'pi pi-play'" />
          </button>
        </div>
        <div class="recap-meta">
          <div class="recap-title">{{ r.title }}</div>
          <div v-if="r.subtitle" class="recap-subtitle">{{ r.subtitle }}</div>
          <div class="recap-count">{{ r.photo_count }} Fotos</div>
        </div>
      </div>
    </div>

    <!-- Detail-Overlay -->
    <div v-if="activeRecapId != null" class="recap-detail-overlay" @click.self="closeDetail">
      <div class="recap-detail">
        <header class="recap-detail-header">
          <div>
            <h2 v-if="detail">{{ detail.title }}</h2>
            <h2 v-else>Rückblick</h2>
            <p v-if="detail?.subtitle" class="recap-subtitle">{{ detail.subtitle }}</p>
          </div>
          <div class="recap-detail-actions">
            <Button
              icon="pi pi-play"
              label="Abspielen"
              :disabled="detailPhotos.length === 0"
              @click="openPlayer"
            />
            <Button
              icon="pi pi-thumbs-down-fill"
              label="Ausblenden"
              severity="secondary"
              text
              :disabled="!detail"
              @click="detail && handleDismiss(detail)"
            />
            <Button icon="pi pi-times" severity="secondary" text @click="closeDetail" />
          </div>
        </header>

        <Message v-if="detailError" severity="error" :closable="false">{{ detailError }}</Message>

        <div v-if="detailLoading" class="recaps-empty">Lade Rückblick …</div>

        <div v-else-if="detailPhotos.length === 0" class="recaps-empty">
          Keine Fotos in diesem Rückblick.
        </div>

        <div v-else class="recap-photo-grid">
          <div
            v-for="photo in detailPhotos"
            :key="photo.id"
            class="recap-photo"
            @click="openPlayer"
          >
            <HeicImage :src="getPhotoUrl(photo.filename, 600)" :alt="photo.original_name" />
          </div>
        </div>
      </div>
    </div>

    <RecapPlayer
      :photos="playerPhotos"
      :title="playerTitle"
      :subtitle="playerSubtitle"
      :music-url="playerMusicUrl"
      :open="playerOpen"
      @close="playerOpen = false"
    />
  </div>
</template>

<style scoped>
.recaps-view {
  padding: 1.5rem;
  max-width: 1400px;
  margin: 0 auto;
}

.recaps-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
}

.recaps-header h1 {
  margin: 0;
  font-size: 1.75rem;
}

.recaps-empty {
  padding: 3rem 1rem;
  text-align: center;
  color: var(--p-text-muted-color, #888);
}

.recaps-empty .hint {
  max-width: 520px;
  margin: 0.5rem auto 0;
  font-size: 0.9rem;
}

.recaps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.recap-card {
  display: flex;
  flex-direction: column;
  border: none;
  padding: 0;
  background: var(--p-content-background, #1e1e1e);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  color: inherit;
  text-align: left;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.recap-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

.recap-cover {
  position: relative;
  aspect-ratio: 4 / 3;
  background: #111;
}

.recap-cover :deep(img),
.recap-cover :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.recap-cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-size: 3rem;
}

.recap-kind-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 10px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  border-radius: 999px;
  font-size: 0.75rem;
}

.recap-card-play {
  position: absolute;
  bottom: 10px;
  right: 10px;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  border: none;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 1.1rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
  transition: background 0.15s ease, transform 0.15s ease;
}

.recap-card-play:hover:not(:disabled) {
  background: var(--p-primary-color, #2563eb);
  transform: scale(1.06);
}

.recap-card-play:disabled {
  cursor: progress;
  opacity: 0.85;
}

.recap-new-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 2px 10px;
  background: var(--p-primary-color, #2563eb);
  color: var(--p-primary-contrast-color, #fff);
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.recap-meta {
  padding: 0.75rem 1rem 1rem;
}

.recap-title {
  font-weight: 600;
  font-size: 1.05rem;
}

.recap-subtitle {
  color: var(--p-text-muted-color, #aaa);
  font-size: 0.85rem;
  margin-top: 2px;
}

.recap-count {
  margin-top: 0.4rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #888);
}

.recap-detail-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 2rem 1rem;
  overflow-y: auto;
}

.recap-detail {
  background: var(--p-content-background, #1e1e1e);
  border-radius: 14px;
  width: min(1200px, 100%);
  padding: 1.25rem 1.5rem 2rem;
}

.recap-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.recap-detail-header h2 {
  margin: 0;
  font-size: 1.5rem;
}

.recap-detail-actions {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}

.recap-photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.5rem;
}

.recap-photo {
  aspect-ratio: 1 / 1;
  overflow: hidden;
  border-radius: 8px;
  background: #111;
  cursor: pointer;
  transition: transform 0.15s ease;
}

.recap-photo:hover {
  transform: scale(1.02);
}

.recap-photo :deep(img),
.recap-photo :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
