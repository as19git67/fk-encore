<script setup lang="ts">
/**
 * Später (the "Later" list, issue #750).
 *
 * Every pending follow-up the user has scheduled, soonest first. Each row shows
 * when the document returns to the work-item basket and lets the user cancel
 * the follow-up (returning it to the basket immediately) or open the document.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useListSearch, useListToolbar } from '../composables/useListToolbar'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import {
  listDocumentFollowUps,
  deleteDocumentFollowUp,
  type DocumentFollowUp,
} from '../api/documents'
import { parseLocalDate } from '../utils/dateFormat'

const router = useRouter()

const items = ref<DocumentFollowUp[]>([])
const loading = ref(false)
const loadError = ref('')
const info = ref('')
const removing = ref<Set<number>>(new Set())

// The endpoint hands over every pending follow-up at once, so the search
// narrows what is already on screen.
const search = useListSearch({
  placeholder: 'Wiedervorlagen filtern…',
  storageKey: 'documents.later.search',
})

const visibleItems = computed(() => {
  const term = search.term.value.trim().toLowerCase()
  if (!term) return items.value
  return items.value.filter((f) =>
    [f.document.title, f.document.original_filename, f.document.sender, f.note].some((field) =>
      field?.toLowerCase().includes(term),
    ),
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
    const res = await listDocumentFollowUps()
    items.value = res.items
  } catch (err: any) {
    loadError.value = err?.message ?? 'Fehler beim Laden der Wiedervorlagen.'
  } finally {
    loading.value = false
  }
}

function openDoc(id: number) {
  router.push({ name: 'dokumente-detail', params: { id } })
}

async function cancel(documentId: number) {
  if (removing.value.has(documentId)) return
  removing.value = new Set(removing.value).add(documentId)
  try {
    await deleteDocumentFollowUp(documentId)
    items.value = items.value.filter((f) => f.document.id !== documentId)
    info.value = 'Wiedervorlage aufgehoben — Dokument ist zurück im Arbeitskorb.'
  } catch (err: any) {
    loadError.value = err?.message ?? 'Aufheben fehlgeschlagen.'
  } finally {
    const next = new Set(removing.value)
    next.delete(documentId)
    removing.value = next
  }
}

function formatDate(dateStr: string): string {
  const d = parseLocalDate(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' })
}

function isDue(dateStr: string): boolean {
  const d = parseLocalDate(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() <= today.getTime()
}

onMounted(load)
</script>

<template>
  <PageLayout
    title="Später"
    hint="Auf Wiedervorlage, sortiert nach Fälligkeit."
    width="normal"
    :ready="!loading"
  >
    <template #actions>
      <Button icon="pi pi-refresh" text rounded :loading="loading" @click="load" />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
    </template>

    <template #notice>
      <Message v-if="info" severity="success" :closable="true" @close="info = ''">
        {{ info }}
      </Message>
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
      icon="pi pi-clock"
      :title="search.term.value ? 'Keine Wiedervorlage passt zur Suche' : 'Keine Wiedervorlagen geplant'"
      :message="search.term.value
        ? 'Andere Wörter finden vielleicht mehr.'
        : 'Lege ein Dokument auf Wiedervorlage, dann taucht es hier auf.'"
      :filtered="!!search.term.value"
      @clear-filters="search.clear"
    />

    <ul v-else class="lv-list">
      <li v-for="f in visibleItems" :key="f.document.id" class="lv-card">
        <button type="button" class="lv-thumb" @click="openDoc(f.document.id)">
          <DocumentThumbnail :id="f.document.id" :alt="f.document.title ?? f.document.original_filename" />
        </button>
        <div class="lv-body" @click="openDoc(f.document.id)">
          <span class="lv-name">{{ f.document.title || f.document.original_filename }}</span>
          <div class="lv-meta">
            <span class="lv-date" :class="{ 'lv-date--due': isDue(f.follow_up_date) }">
              <i class="pi pi-clock" /> {{ formatDate(f.follow_up_date) }}
            </span>
            <span v-if="f.note" class="lv-note"><i class="pi pi-comment" /> {{ f.note }}</span>
          </div>
        </div>
        <Button
          icon="pi pi-times"
          label="Aufheben"
          text
          severity="secondary"
          :loading="removing.has(f.document.id)"
          @click="cancel(f.document.id)"
        />
      </li>
    </ul>
    </div>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). */
.content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lv-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lv-card {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 10px 12px;
}
.lv-thumb {
  flex: 0 0 56px;
  width: 56px;
  height: 72px;
  border: 0;
  padding: 0;
  background: var(--p-content-hover-background);
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
}
.lv-thumb :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.lv-body {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}
.lv-name {
  font-weight: 600;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 4px;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}
.lv-meta i {
  margin-right: 3px;
}
.lv-date--due {
  color: var(--p-orange-500);
  font-weight: 600;
}
</style>
