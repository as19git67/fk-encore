<script setup lang="ts">
/**
 * Fotos › Fotobücher — the caller's photo books (documentation/plans/fotobuch.md).
 * A book is started from a selection in the gallery or from an album
 * ("Fotobuch gestalten"); this list opens the ones that exist.
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageLayout from '../components/layout/PageLayout.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { PHOTO_BOOK_FORMATS, listPhotoBooks, photoBookThumbUrl, type PhotoBookSummary } from '../api/photoBooks'
import { MODULE_LIST_ANCHORS, anchorKey, saveListAnchor } from '../utils/listAnchor'

const ANCHOR_KEY = MODULE_LIST_ANCHORS.photoBook.key

const router = useRouter()
const books = ref<PhotoBookSummary[]>([])
const loading = ref(true)
const loadError = ref('')

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    books.value = (await listPhotoBooks()).books
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fotobücher konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function open(book: PhotoBookSummary) {
  saveListAnchor(ANCHOR_KEY, { kind: 'photo-book', id: book.id })
  void router.push({ name: 'fotos-photo-book', params: { id: book.id } })
}

function formatName(id: string): string {
  return PHOTO_BOOK_FORMATS.find((f) => f.id === id)?.name ?? id
}

function changed(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })
}

onMounted(load)
</script>

<template>
  <PageLayout
    title="Fotobücher"
    hint="Ein Fotobuch entsteht aus gewählten Fotos in der Galerie oder aus einem Album: „Fotobuch gestalten“."
    width="wide"
    :ready="!loading"
    :anchor-key="ANCHOR_KEY"
  >
    <template #notice>
      <ErrorBanner v-if="loadError" :message="loadError" @retry="load" />
    </template>

    <PageSkeleton v-if="loading && !books.length" variant="grid" :count="4" />
    <EmptyState
      v-else-if="!books.length && !loadError"
      icon="pi pi-book"
      title="Noch kein Fotobuch"
      message="Fotos in der Galerie auswählen oder ein Album öffnen und „Fotobuch gestalten“ wählen."
    />
    <ul v-else class="pb-list">
      <li v-for="book in books" :key="book.id">
        <button
          type="button"
          class="pb-card scroll-anchor"
          :data-anchor="anchorKey('photo-book', book.id)"
          @click="open(book)"
        >
          <span class="pb-cover">
            <img v-if="book.cover_filename" :src="photoBookThumbUrl(book.cover_filename, 400)" alt="" loading="lazy" />
            <i v-else class="pi pi-book" aria-hidden="true" />
          </span>
          <span class="pb-text">
            <span class="pb-title">{{ book.title }}</span>
            <span v-if="book.subtitle" class="pb-sub">{{ book.subtitle }}</span>
            <span class="pb-meta">
              {{ formatName(book.format) }} · {{ book.page_count }} Seiten · {{ book.photo_count }} Fotos · geändert {{ changed(book.updated_at) }}
            </span>
          </span>
        </button>
      </li>
    </ul>
  </PageLayout>
</template>

<style scoped>
.pb-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-4);
}
.pb-card {
  width: 100%;
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  font: inherit;
}
.pb-card:hover {
  background: var(--p-content-hover-background);
}
.pb-card:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.pb-cover {
  aspect-ratio: 3 / 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.05);
  color: var(--p-text-muted-color);
  font-size: var(--text-3xl);
}
.pb-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pb-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
}
.pb-title {
  font-weight: 600;
}
.pb-sub,
.pb-meta {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
</style>
