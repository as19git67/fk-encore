<script setup lang="ts">
/**
 * Sammelmappen — the list of folders.
 *
 * A folder is what actually gets handed over: to a Steuerberater, an insurer,
 * a landlord. This view is the entry point to building one; the ordering,
 * page selection and export live in the detail view.
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import PageLayout from '../components/layout/PageLayout.vue'
import {
  createCollection,
  deleteCollection,
  listCollections,
  type DocumentCollection,
} from '../api/collections'

const router = useRouter()

const items = ref<DocumentCollection[]>([])
const loading = ref(false)
const loadError = ref('')
const info = ref('')

const createOpen = ref(false)
const creating = ref(false)
const newTitle = ref('')
const newNotes = ref('')

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    items.value = (await listCollections()).items
  } catch (err: any) {
    loadError.value = err?.message ?? 'Sammelmappen konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function open(id: number) {
  router.push({ name: 'dokumente-mappe', params: { id } })
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
    open(created.id)
  } catch (err: any) {
    loadError.value = err?.message ?? 'Anlegen fehlgeschlagen.'
  } finally {
    creating.value = false
  }
}

async function remove(collection: DocumentCollection) {
  if (!window.confirm(`Sammelmappe „${collection.title}" löschen? Die Dokumente bleiben erhalten.`)) {
    return
  }
  try {
    await deleteCollection(collection.id)
    items.value = items.value.filter((c) => c.id !== collection.id)
    info.value = `„${collection.title}" gelöscht — die Dokumente sind unverändert.`
  } catch (err: any) {
    loadError.value = err?.message ?? 'Löschen fehlgeschlagen.'
  }
}

function formatDate(value: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

onMounted(load)
</script>

<template>
  <PageLayout
    title="Sammelmappen"
    :hint="`${items.length} Mappen · Mehrere Dokumente zusammenfassen und als ein PDF weitergeben. Ein Dokument darf in mehreren Mappen liegen.`"
    width="normal"
    :ready="!loading"
  >
    <template #actions>
      <Button icon="pi pi-plus" label="Neue Mappe" @click="openCreate" />
      <Button icon="pi pi-refresh" text rounded :loading="loading" @click="load" />
    </template>

    <template #notice>
      <Message v-if="info" severity="success" closable @close="info = ''">{{ info }}</Message>
      <Message v-if="loadError" severity="error" closable @close="loadError = ''">
        {{ loadError }}
      </Message>
    </template>

    <div class="content">
    <div v-if="!loading && items.length === 0 && !loadError" class="cv-empty">
      <i class="pi pi-folder" />
      <p>Noch keine Sammelmappe angelegt.</p>
    </div>

    <ul class="cv-list">
      <li v-for="c in items" :key="c.id" class="cv-card">
        <button type="button" class="cv-body" @click="open(c.id)">
          <div class="cv-line">
            <span class="cv-name">{{ c.title }}</span>
            <Tag v-if="c.visibility === 'group'" value="Gruppe" icon="pi pi-users" severity="info" />
          </div>
          <p v-if="c.summary" class="cv-summary">{{ c.summary }}</p>
          <p v-else-if="c.summary_stale && c.item_count > 0" class="cv-summary cv-summary--pending">
            Zusammenfassung wird erstellt …
          </p>
          <div class="cv-meta">
            <span>
              <i class="pi pi-file" />
              {{ c.included_count }} von {{ c.item_count }}
              {{ c.item_count === 1 ? 'Dokument' : 'Dokumenten' }} im PDF
            </span>
            <span v-if="formatDate(c.updated_at)">
              <i class="pi pi-clock" /> {{ formatDate(c.updated_at) }}
            </span>
          </div>
        </button>
        <Button
          v-if="c.can_administer"
          icon="pi pi-trash"
          text
          rounded
          severity="danger"
          aria-label="Sammelmappe löschen"
          @click="remove(c)"
        />
      </li>
    </ul>
    </div>

    <Dialog
      v-model:visible="createOpen"
      modal
      header="Neue Sammelmappe"
      :style="{ width: 'min(480px, 94vw)' }"
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
.cv-empty {
  text-align: center;
  color: var(--p-text-muted-color);
  padding: 48px 16px;
}
.cv-empty .pi-folder {
  font-size: 2.5rem;
  margin-bottom: 12px;
}
.cv-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cv-card {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  padding: 12px 12px 12px 14px;
}
.cv-body {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: none;
  padding: 0;
  text-align: left;
  color: var(--p-text-color);
  cursor: pointer;
}
.cv-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cv-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cv-summary {
  margin: 6px 0 0;
  color: var(--p-text-muted-color);
  font-size: 0.84rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cv-summary--pending {
  font-style: italic;
}
.cv-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.cv-meta i {
  margin-right: 3px;
}
.cv-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cv-form label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  margin-top: 6px;
}
</style>
