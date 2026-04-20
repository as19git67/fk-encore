<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import HeicImage from './HeicImage.vue'
import { listRecaps, type RecapSummary, type RecapKind } from '../api/recaps'
import { getPhotoDetailsBatch, getPhotoUrl } from '../api/photos'

const router = useRouter()

const recaps = ref<RecapSummary[]>([])
const coverFilenames = ref<Record<number, string>>({})
const loading = ref(true)
const error = ref('')

const kindLabels: Record<RecapKind, string> = {
  on_this_day: 'Heute vor…',
  trip: 'Reise',
  person: 'Person',
  place: 'Ort',
  theme: 'Thema',
  recent_highlights: 'Kürzlich',
}

async function load() {
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
    }
  } catch (err: any) {
    error.value = err?.message ?? 'Rückblicke konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function openRecap(r: RecapSummary) {
  router.push({ name: 'fotos-recaps', query: { id: String(r.id) } })
}

function openAll() {
  router.push({ name: 'fotos-recaps' })
}

function coverUrl(photoId: number | null, size = 400): string | null {
  if (!photoId) return null
  const filename = coverFilenames.value[photoId]
  if (!filename) return null
  return getPhotoUrl(filename, size)
}

onMounted(load)
</script>

<template>
  <section v-if="!loading && recaps.length > 0" class="recaps-carousel">
    <header class="recaps-carousel-header">
      <h2>Rückblicke</h2>
      <button type="button" class="recaps-carousel-all" @click="openAll">
        Alle ansehen
        <i class="pi pi-chevron-right" />
      </button>
    </header>
    <div class="recaps-carousel-track">
      <button
        v-for="r in recaps"
        :key="r.id"
        type="button"
        class="recaps-carousel-card"
        @click="openRecap(r)"
      >
        <div class="recaps-carousel-cover">
          <HeicImage
            v-if="coverUrl(r.cover_photo_id, 400)"
            :src="coverUrl(r.cover_photo_id, 400) as string"
            alt=""
          />
          <div v-else class="recaps-carousel-cover-fallback">
            <i class="pi pi-images" />
          </div>
          <span v-if="!r.seen_at" class="recaps-carousel-new">Neu</span>
          <div class="recaps-carousel-overlay">
            <span class="recaps-carousel-kind">{{ kindLabels[r.kind] }}</span>
            <span class="recaps-carousel-title">{{ r.title }}</span>
            <span v-if="r.subtitle" class="recaps-carousel-subtitle">{{ r.subtitle }}</span>
          </div>
        </div>
      </button>
    </div>
  </section>
</template>

<style scoped>
.recaps-carousel {
  margin: 0.5rem 0 1rem;
}

.recaps-carousel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.recaps-carousel-header h2 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.recaps-carousel-all {
  background: none;
  border: none;
  color: var(--p-primary-color, #6ea8ff);
  cursor: pointer;
  font-size: 0.85rem;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
}

.recaps-carousel-all:hover {
  background: rgba(110, 168, 255, 0.12);
}

.recaps-carousel-track {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  padding: 0.25rem 0.25rem 0.75rem;
  scroll-snap-type: x mandatory;
  scrollbar-width: thin;
}

.recaps-carousel-card {
  flex: 0 0 auto;
  width: 240px;
  aspect-ratio: 4 / 5;
  border: none;
  padding: 0;
  border-radius: 14px;
  overflow: hidden;
  cursor: pointer;
  position: relative;
  background: #111;
  scroll-snap-align: start;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.recaps-carousel-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
}

.recaps-carousel-cover {
  position: relative;
  width: 100%;
  height: 100%;
  background: #111;
}

.recaps-carousel-cover :deep(img),
.recaps-carousel-cover :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.recaps-carousel-cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #555;
  font-size: 3rem;
}

.recaps-carousel-overlay {
  position: absolute;
  inset: auto 0 0 0;
  padding: 1.5rem 0.75rem 0.75rem;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0) 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}

.recaps-carousel-new {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 2px 10px;
  background: var(--p-primary-color, #2563eb);
  color: var(--p-primary-contrast-color, #fff);
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.recaps-carousel-kind {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.85;
  background: rgba(0, 0, 0, 0.55);
  padding: 2px 8px;
  border-radius: 999px;
  margin-bottom: 0.35rem;
}

.recaps-carousel-title {
  font-weight: 600;
  font-size: 1rem;
  line-height: 1.2;
}

.recaps-carousel-subtitle {
  font-size: 0.8rem;
  opacity: 0.85;
  margin-top: 0.2rem;
}

@media (max-width: 640px) {
  .recaps-carousel-card {
    width: 180px;
  }
}
</style>
