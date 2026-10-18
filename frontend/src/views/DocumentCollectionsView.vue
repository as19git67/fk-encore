<script setup lang="ts">
/**
 * Sammelmappen — the list of folders.
 *
 * A folder is what actually gets handed over: to a Steuerberater, an insurer,
 * a landlord. This view is the entry point to building one; the ordering,
 * page selection and export live in the detail view.
 *
 * The tiles and their menu are the ones the Sammelmappen page shows
 * (components/collections/CollectionTiles.vue): the folders that can hold
 * documents — typed for documents, Akten, and mixed ones.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import CollectionTiles from '../components/collections/CollectionTiles.vue'
import Textarea from 'primevue/textarea'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useListSearch, useListToolbar } from '../composables/useListToolbar'
import {
  createCollection,
  listAllCollections,
  markCollectionOpened,
  type CollectionSummary,
} from '../api/collections'
import { collectionRoute } from '../utils/collectionRoute'
import { saveListAnchor } from '../utils/listAnchor'

const router = useRouter()

/** One key for this list — anchor and scroll offset are stored under it. */
const ANCHOR_KEY = 'dokumente-mappen'

const items = ref<CollectionSummary[]>([])
// True from the start: PageLayout restores the row on the way back once the
// page is ready, and an empty list before the first load has no row to find.
const loading = ref(true)
const loadError = ref('')
const info = ref('')

const createOpen = ref(false)
const creating = ref(false)
const newTitle = ref('')
const newNotes = ref('')

// The whole list arrives in one response, so filtering stays client-side.
const search = useListSearch({
  placeholder: 'Mappen filtern…',
  storageKey: 'collections.search',
})

const visibleItems = computed(() => {
  const term = search.term.value.trim().toLowerCase()
  if (!term) return items.value
  return items.value.filter((c) =>
    [c.name, c.description].some((field) => field?.toLowerCase().includes(term)),
  )
})

const toolbar = useListToolbar({
  search,
  result: {
    loaded: () => visibleItems.value.length,
    total: () => items.value.length,
    loading: () => loading.value,
  },
})

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    // What this list showed before the shared tiles: folders that can hold
    // documents — typed for them or mixed — and never the basket.
    items.value = (await listAllCollections()).items.filter(
      (c) => (c.entity_type === 'document' || c.entity_type === null) && c.kind !== 'basket',
    )
  } catch (err: any) {
    loadError.value = err?.message ?? 'Sammelmappen konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function open(c: Pick<CollectionSummary, 'id' | 'entity_type' | 'kind'>) {
  // The row, not the offset: a mappe that gained a summary while it was open
  // changes the height of everything below it.
  saveListAnchor(ANCHOR_KEY, { kind: 'collection', id: c.id })
  void markCollectionOpened(c.id).catch(() => { /* the visit is a hint, not a must */ })
  router.push(collectionRoute(c))
}

function openCreate() {
  newTitle.value = ''
  newNotes.value = ''
  createOpen.value = true
}

async function create() {
  const title = newTitle.value.trim()
  if (!title || creating.value) return
  creating.value = true
  try {
    const created = await createCollection({ title, notes: newNotes.value.trim() || null })
    createOpen.value = false
    open({ id: created.id, entity_type: 'document', kind: created.kind })
  } catch (err: any) {
    loadError.value = err?.message ?? 'Anlegen fehlgeschlagen.'
  } finally {
    creating.value = false
  }
}

onMounted(load)
</script>

<template>
  <PageLayout
    title="Sammelmappen"
    hint="Mehrere Dokumente zusammenfassen und als ein PDF weitergeben. Ein Dokument darf in mehreren Mappen liegen."
    width="full"
    :ready="!loading"
    :anchor-key="ANCHOR_KEY"
  >
    <template #actions>
      <Button icon="pi pi-plus" label="Neue Mappe" @click="openCreate" />
      <Button icon="pi pi-refresh" aria-label="Liste neu laden" v-tooltip.bottom="'Neu laden'" text rounded :loading="loading" @click="load" />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
    </template>

    <template #notice>
      <Message v-if="info" severity="success" closable @close="info = ''">{{ info }}</Message>
      <ErrorBanner
        v-if="loadError"
        :message="loadError"
        closable
        @retry="load"
        @close="loadError = ''"
      />
    </template>

    <div class="content">
    <PageSkeleton v-if="loading && items.length === 0" variant="list" :count="6" />

    <EmptyState
      v-else-if="visibleItems.length === 0 && !loadError"
      icon="pi pi-folder"
      :title="search.term.value ? 'Keine Mappe passt zur Suche' : 'Noch keine Sammelmappe angelegt'"
      :message="search.term.value
        ? 'Andere Wörter finden vielleicht mehr.'
        : 'Lege eine Mappe an und lege Dokumente hinein — daraus wird ein PDF.'"
      :filtered="!!search.term.value"
      @clear-filters="search.clear"
    />

    <CollectionTiles
      v-else
      :items="visibleItems"
      @open="open"
      @changed="load"
      @error="(message) => (loadError = message)"
      @notice="(message) => (info = message)"
    />
    </div>

    <Dialog
    class="dialog-sm"
      v-model:visible="createOpen"
      modal
      header="Neue Sammelmappe"
    >
      <div class="cv-form">
        <label for="cv-new-title">Titel</label>
        <InputText id="cv-new-title" v-model="newTitle" autofocus @keyup.enter="create" />
        <label for="cv-new-notes">Notiz (erscheint auf dem Deckblatt)</label>
        <Textarea id="cv-new-notes" v-model="newNotes" rows="3" auto-resize />
      </div>
      <template #footer>
        <Button label="Abbrechen" text severity="secondary" @click="createOpen = false" />
        <Button
          label="Anlegen"
          icon="pi pi-check"
          :disabled="!newTitle.trim()"
          :loading="creating"
          @click="create"
        />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.cv-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cv-form label {
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
  margin-top: 6px;
}
</style>
