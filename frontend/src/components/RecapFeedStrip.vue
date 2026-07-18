<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import HeicImage from './HeicImage.vue'
import { listRecaps, type RecapSummary, type RecapKind } from '../api/recaps'
import { getPhotoDetailsBatch, getPhotoUrl } from '../api/photos'

/**
 * Horizontal strip of unseen recaps for the top of the photo feed. Renders
 * nothing when there are no unseen recaps or the fetch fails — the feed
 * must never break because of the strip. Tapping a card jumps into the
 * recap player (RecapsView handles the `play=1` query).
 */
const MAX_CARDS = 10

const router = useRouter()
const recaps = ref<RecapSummary[]>([])
const coverFilenames = ref<Record<number, string>>({})
const loaded = ref(false)

const unseen = computed(() =>
  recaps.value.filter((r) => !r.seen_at).slice(0, MAX_CARDS)
)

onMounted(async () => {
  try {
    const res = await listRecaps()
    recaps.value = res.recaps
    const ids = Array.from(
      new Set(
        res.recaps
          .filter((r) => !r.seen_at)
          .map((r) => r.cover_photo_id)
          .filter((id): id is number => typeof id === 'number')
      )
    )
    if (ids.length > 0) {
      const details = await getPhotoDetailsBatch(ids)
      const map: Record<number, string> = {}
      for (const p of details.photos) map[p.id] = p.filename
      coverFilenames.value = map
    }
  } catch {
    // Silent: the strip simply stays hidden.
  } finally {
    loaded.value = true
  }
})

const kindLabels: Record<RecapKind, string> = {
  on_this_day: 'Heute vor…',
  trip: 'Reise',
  person: 'Person',
  place: 'Ort',
  theme: 'Thema',
  recent_highlights: 'Kürzlich',
  scene_then_now: 'Damals & heute',
}

function coverUrl(r: RecapSummary): string | null {
  if (!r.cover_photo_id) return null
  const filename = coverFilenames.value[r.cover_photo_id]
  return filename ? getPhotoUrl(filename, 400) : null
}

function openRecap(r: RecapSummary) {
  void router.push({
    path: '/fotos/rueckblicke',
    query: { id: String(r.id), play: '1' },
  })
}
</script>

<template>
  <section v-if="loaded && unseen.length > 0" class="recap-strip" aria-label="Neue Rückblicke">
    <div class="recap-strip-header">
      <h2>Neue Rückblicke</h2>
      <router-link class="recap-strip-all" to="/fotos/rueckblicke">Alle</router-link>
    </div>
    <div class="recap-strip-scroller">
      <button
        v-for="r in unseen"
        :key="r.id"
        type="button"
        class="recap-strip-card"
        :aria-label="`Rückblick „${r.title}“ abspielen`"
        @click="openRecap(r)"
      >
        <div class="recap-strip-cover">
          <HeicImage v-if="coverUrl(r)" :src="coverUrl(r) as string" alt="" />
          <div v-else class="recap-strip-cover-fallback">
            <i class="pi pi-images" />
          </div>
          <span class="recap-strip-kind">{{ kindLabels[r.kind] }}</span>
          <span class="recap-strip-play"><i class="pi pi-play" /></span>
        </div>
        <div class="recap-strip-title">{{ r.title }}</div>
        <div v-if="r.subtitle" class="recap-strip-subtitle">{{ r.subtitle }}</div>
      </button>
    </div>
  </section>
</template>

<style scoped>
.recap-strip-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.recap-strip-header h2 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
}

.recap-strip-all {
  font-size: 0.85rem;
  color: var(--p-primary-color, #2563eb);
  text-decoration: none;
}

.recap-strip-all:hover {
  text-decoration: underline;
}

.recap-strip-scroller {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 0.25rem;
  /* Snappy horizontal swiping on touch devices. */
  scroll-snap-type: x proximity;
}

.recap-strip-scroller::-webkit-scrollbar {
  display: none;
}

.recap-strip-card {
  flex: 0 0 auto;
  width: 150px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  scroll-snap-align: start;
}

.recap-strip-cover {
  position: relative;
  width: 150px;
  height: 190px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--p-content-hover-background, #222);
}

.recap-strip-cover :deep(img),
.recap-strip-cover :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.recap-strip-card:hover .recap-strip-cover {
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
}

.recap-strip-cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--p-text-muted-color, #777);
  font-size: 2rem;
}

.recap-strip-kind {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 0.7rem;
}

.recap-strip-play {
  position: absolute;
  bottom: 8px;
  right: 8px;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  backdrop-filter: blur(4px);
}

.recap-strip-card:hover .recap-strip-play {
  background: var(--p-primary-color, #2563eb);
}

.recap-strip-title {
  margin-top: 0.4rem;
  font-size: 0.9rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recap-strip-subtitle {
  font-size: 0.78rem;
  color: var(--p-text-muted-color, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
