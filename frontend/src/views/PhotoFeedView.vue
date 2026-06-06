<script setup lang="ts">
import { onMounted, onBeforeUnmount, nextTick, ref } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import PhotoFeedCard from '../components/PhotoFeedCard.vue'
import { listPhotoFeed, type FeedPhotoItem, type PhotoFeedCursor } from '../api/photoFeed'
import { updatePhotoCuration } from '../api/photos'
import { createComment } from '../api/reactions'
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
      <Button
        v-if="hasNew"
        label="Neue Aktivität"
        icon="pi pi-arrow-up"
        size="small"
        rounded
        @click="refresh"
      />
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
