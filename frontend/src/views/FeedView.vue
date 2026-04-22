<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import {
  listFeed,
  markFeedSeen,
  type FeedItem,
} from '../api/feed'
import { getPhotoUrl } from '../api/photos'
import { useRealtimeEvent } from '../composables/useRealtime'

const router = useRouter()

const items = ref<FeedItem[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const error = ref('')
const nextCursor = ref<number | null>(null)
const unreadCount = ref(0)

const hasMore = computed(() => nextCursor.value !== null)

async function loadInitial() {
  loading.value = true
  error.value = ''
  try {
    const res = await listFeed({ limit: 25 })
    items.value = res.items
    nextCursor.value = res.nextCursor
    unreadCount.value = res.unreadCount
    // Mark everything we just showed as seen. The server does the
    // actual "<= upToId" update; we only keep the local counter in
    // sync so the badge disappears immediately.
    const highestId = res.items[0]?.id
    if (highestId) {
      await markFeedSeen(highestId).catch(() => {})
      unreadCount.value = 0
      for (const item of items.value) {
        if (item.seen_at === null) item.seen_at = new Date().toISOString()
      }
    }
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
    const res = await listFeed({ cursor: nextCursor.value, limit: 25 })
    items.value.push(...res.items)
    nextCursor.value = res.nextCursor
  } catch (err: any) {
    error.value = err.message || 'Fehler beim Laden weiterer Einträge'
  } finally {
    loadingMore.value = false
  }
}

// Live-insert: when a new feed item arrives while the view is open,
// reload the first page so it appears at the top. Cheaper than
// reconstructing a single item from the event payload (we would
// still need the joined actor/album/photo metadata).
useRealtimeEvent('feed', 'item.added', () => {
  void loadInitial()
})

function kindLabel(item: FeedItem): string {
  const actor = item.actor.name ?? 'Jemand'
  const album = item.album?.name ?? 'einem Album'
  switch (item.kind) {
    case 'photo_added':
      return `${actor} hat ein Foto zu „${album}" hinzugefügt`
    case 'album_shared':
      return `${actor} hat das Album „${album}" mit dir geteilt`
    case 'photo_liked':
      return `${actor} hat ein Foto mit ❤ markiert`
    case 'photo_commented':
      return `${actor} hat ein Foto kommentiert`
    default:
      return `${actor}: ${item.kind}`
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.round(diffMs / 60_000)
  if (diffMin < 1) return 'gerade eben'
  if (diffMin < 60) return `vor ${diffMin} min`
  const diffH = Math.round(diffMin / 60)
  if (diffH < 24) return `vor ${diffH} h`
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function openItem(item: FeedItem): void {
  // Prefer navigating to the photo within its album if we have both
  // anchors; fall back to the album list.
  if (item.album) {
    router.push({
      name: 'fotos-album-detail',
      params: { id: item.album.id },
      query: item.photo ? { photoId: item.photo.id } : undefined,
    })
  } else if (item.photo) {
    router.push({ name: 'fotos-gallery', query: { photoId: item.photo.id } })
  }
}

onMounted(() => {
  void loadInitial()
})
</script>

<template>
  <div class="feed-view">
    <div class="header">
      <h1 class="title">Feed</h1>
      <span v-if="unreadCount > 0" class="badge">{{ unreadCount }} neu</span>
    </div>

    <Message v-if="error" severity="error" @close="error = ''">{{ error }}</Message>

    <div v-if="loading" class="info-text">
      <i class="pi pi-spin pi-spinner" /> Feed wird geladen…
    </div>
    <div v-else-if="items.length === 0" class="info-text">
      Noch keine Feed-Einträge. Sobald jemand Fotos teilt oder zu geteilten
      Alben hinzufügt, erscheinen sie hier.
    </div>

    <div v-else class="feed-list">
      <div
        v-for="item in items"
        :key="item.id"
        :class="['feed-card', { 'feed-card--unseen': item.seen_at === null }]"
        tabindex="0"
        @click="openItem(item)"
        @keydown.enter="openItem(item)"
      >
        <div v-if="item.photo" class="feed-thumb">
          <img
            :src="getPhotoUrl(item.photo.filename, 400)"
            :alt="item.photo.filename"
            loading="lazy"
          />
        </div>
        <div v-else class="feed-thumb feed-thumb--placeholder">
          <i class="pi pi-folder-open" />
        </div>

        <div class="feed-body">
          <div class="feed-text">{{ kindLabel(item) }}</div>
          <div class="feed-meta">{{ formatDate(item.created_at) }}</div>
        </div>
      </div>

      <div v-if="hasMore" class="load-more">
        <Button
          label="Weitere laden"
          severity="secondary"
          :loading="loadingMore"
          @click="loadMore"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.feed-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  padding-inline: 0.5em;
}

@media (min-width: 800px) {
  .feed-view { padding-inline: 1em; }
}

.title {
  font-size: 1.5em;
  font-weight: 600;
  margin-block: 0.25em;
}

.header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-block: 0.25rem 0.5rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.15em 0.6em;
  background: var(--p-primary-color);
  color: var(--p-primary-contrast-color);
  border-radius: 999px;
  font-size: 0.8em;
  font-weight: 600;
}

.info-text {
  text-align: center;
  margin-top: 4rem;
  color: var(--p-text-muted-color);
}

.feed-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.feed-card {
  display: flex;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.1s;
}
.feed-card:hover,
.feed-card:focus-visible {
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}

.feed-card--unseen {
  border-left: 3px solid var(--p-primary-color);
}

.feed-thumb {
  width: 64px;
  height: 64px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--p-surface-ground);
  display: flex;
  align-items: center;
  justify-content: center;
}
.feed-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.feed-thumb--placeholder i {
  font-size: 1.75rem;
  color: var(--p-text-muted-color);
}

.feed-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.25rem;
}

.feed-text {
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.feed-meta {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.load-more {
  display: flex;
  justify-content: center;
  margin-block: 1rem;
}
</style>
