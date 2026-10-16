<script setup lang="ts">
/**
 * A collection behind an anonymous share link (#1548, stage 8).
 *
 * Shown to anyone who has the link, without signing in, as the collection is
 * at the moment it is opened: its photos, its albums and its whole documents.
 * Images come re-encoded by the server, without place or camera data.
 */
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Galleria from 'primevue/galleria'
import { ApiError } from '../api/client'
import PageLayout from '../components/layout/PageLayout.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import {
  getPublicCollection,
  publicCollectionDocumentUrl,
  publicCollectionPhotoUrl,
  type PublicCollection,
  type PublicDocument,
} from '../api/collections'

const route = useRoute()
const token = computed(() => String(route.params.token ?? ''))
const data = ref<PublicCollection | null>(null)
const loading = ref(true)
const error = ref('')
const gone = ref(false)

let loadSeq = 0
async function load() {
  if (!token.value) return
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  gone.value = false
  try {
    const result = await getPublicCollection(token.value)
    if (seq === loadSeq) data.value = result
  } catch (err: unknown) {
    if (seq !== loadSeq) return
    data.value = null
    if (err instanceof ApiError && err.code === 'not_found') gone.value = true
    else error.value = err instanceof Error ? err.message : 'Die Mappe konnte nicht geladen werden.'
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}
watch(token, load, { immediate: true })

interface Section {
  key: string
  title: string
  photoIds: number[]
}

/** Loose photos first, then one section per album. */
const sections = computed<Section[]>(() => {
  const d = data.value
  if (!d) return []
  const inAlbums = new Set(d.albums.flatMap((a) => a.photo_ids))
  const loose = d.photos.filter((p) => !inAlbums.has(p.id)).map((p) => p.id)
  const out: Section[] = []
  if (loose.length) out.push({ key: 'photos', title: 'Fotos', photoIds: loose })
  for (const a of d.albums) {
    if (a.photo_ids.length) out.push({ key: `album-${a.id}`, title: a.title, photoIds: a.photo_ids })
  }
  return out
})

/** Every photo in the order it is shown, for paging in the full view. */
const sequence = computed(() => sections.value.flatMap((s) => s.photoIds))
const galleryItems = computed(() => sequence.value.map((id) => ({ id, src: publicCollectionPhotoUrl(token.value, id) })))

const fullscreen = ref(false)
const activeIndex = ref(0)
function open(photoId: number) {
  activeIndex.value = Math.max(0, sequence.value.indexOf(photoId))
  fullscreen.value = true
}

const isEmpty = computed(() => !!data.value && sequence.value.length === 0 && data.value.documents.length === 0)

const hint = computed(() => {
  const d = data.value
  if (!d) return undefined
  const until = d.expires_at ? ` · Link gültig bis ${new Date(d.expires_at).toLocaleDateString('de-DE')}` : ''
  return `Geteilte Sammelmappe${until}`
})

function docDate(doc: PublicDocument): string {
  return doc.date ? new Date(doc.date).toLocaleDateString('de-DE') : ''
}
</script>

<template>
  <PageLayout :title="data?.title ?? 'Geteilte Sammelmappe'" :hint="hint" :ready="!loading">
    <template #notice>
      <ErrorBanner v-if="error" :message="error" @retry="load" />
    </template>

    <PageSkeleton v-if="loading" variant="grid" :count="8" />
    <EmptyState
      v-else-if="gone"
      icon="pi pi-link"
      title="Link nicht mehr gültig"
      message="Der Link ist abgelaufen oder wurde beendet. Frag bei der Person nach, die ihn geteilt hat."
    />
    <template v-else-if="data">
      <p v-if="data.description" class="shared-description">{{ data.description }}</p>

      <EmptyState v-if="isEmpty" icon="pi pi-inbox" title="Hier liegt gerade nichts" />

      <section v-for="s in sections" :key="s.key" class="shared-section" :aria-label="s.title">
        <h2 class="shared-heading">{{ s.title }} <span class="shared-count">{{ s.photoIds.length }}</span></h2>
        <ul class="shared-grid">
          <li v-for="id in s.photoIds" :key="id">
            <button type="button" class="shared-tile" :aria-label="`Foto ${sequence.indexOf(id) + 1} groß zeigen`" @click="open(id)">
              <img :src="publicCollectionPhotoUrl(token, id, 480)" alt="" loading="lazy" />
            </button>
          </li>
        </ul>
      </section>

      <section v-if="data.documents.length" class="shared-section" aria-label="Dokumente">
        <h2 class="shared-heading">Dokumente <span class="shared-count">{{ data.documents.length }}</span></h2>
        <ul class="shared-docs">
          <li v-for="doc in data.documents" :key="doc.id" class="shared-doc">
            <i class="pi pi-file shared-doc-icon" aria-hidden="true" />
            <div class="shared-doc-body">
              <span class="shared-doc-title">{{ doc.title }}</span>
              <span v-if="doc.date" class="shared-muted">{{ docDate(doc) }}</span>
            </div>
            <Button
              as="a"
              :href="publicCollectionDocumentUrl(token, doc.id)"
              target="_blank"
              rel="noopener"
              icon="pi pi-download"
              text
              rounded
              :aria-label="`${doc.title} herunterladen`"
            />
          </li>
        </ul>
      </section>

      <p v-if="data.withheld.length" class="shared-muted shared-withheld">
        Nicht geteilt:
        {{ data.withheld.map((w) => `${w.count} ${w.kind}`).join(', ') }}.
      </p>
    </template>

    <Galleria
      v-model:visible="fullscreen"
      v-model:active-index="activeIndex"
      :value="galleryItems"
      full-screen
      :show-thumbnails="false"
      show-item-navigators
      :circular="false"
    >
      <template #item="{ item }">
        <img :src="item.src" alt="" class="shared-full" />
      </template>
    </Galleria>
  </PageLayout>
</template>

<style scoped>
.shared-description {
  margin: 0 0 var(--space-4);
  color: var(--p-text-muted-color);
  white-space: pre-line;
}
.shared-section {
  margin-bottom: var(--space-5);
}
.shared-heading {
  font-size: var(--text-lg);
  margin: 0 0 var(--space-2);
}
.shared-count {
  font-size: var(--text-sm);
  font-weight: normal;
  color: var(--p-text-muted-color);
}
.shared-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: var(--space-1);
}
.shared-tile {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  border: none;
  border-radius: var(--p-border-radius-sm, 4px);
  background: var(--p-content-hover-background);
  cursor: zoom-in;
  overflow: hidden;
  /* The tile fills its cell and clips its image, so the ring sits inside. */
  outline-offset: var(--focus-ring-offset-inset);
}
.shared-tile:focus-visible {
  outline: var(--focus-ring);
}
.shared-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.shared-docs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.shared-doc {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--p-content-border-color);
  border-radius: var(--p-border-radius-md, 6px);
}
.shared-doc-icon {
  color: var(--p-text-muted-color);
}
.shared-doc-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.shared-doc-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shared-muted {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.shared-withheld {
  margin: 0;
}
.shared-full {
  max-width: 100vw;
  max-height: 90dvh;
  object-fit: contain;
  display: block;
}
</style>
