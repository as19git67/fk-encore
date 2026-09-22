<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'
import Tag from 'primevue/tag'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import { useListToolbar, useListView } from '../composables/useListToolbar'
import {
  acceptCategorySuggestion,
  listCategorySuggestions,
  listDocumentCategories,
  rejectCategorySuggestion,
  type CategorySuggestion,
  type CategorySuggestionStatus,
  type DocumentCategory,
} from '../api/documents'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const items = ref<CategorySuggestion[]>([])
const categoriesBySlug = ref<Map<string, DocumentCategory>>(new Map())
const loading = ref(true)
const error = ref('')
const info = ref('')

const filterOptions: Array<{ label: string; value: CategorySuggestionStatus }> = [
  { label: 'Offen', value: 'open' },
  { label: 'Akzeptiert', value: 'accepted' },
  { label: 'Abgelehnt', value: 'rejected' },
]

// The status picker lives in `?status=` so a reload or a shared link opens
// the same list instead of snapping back to "Offen" (issue #1272, stage 3).
const statusView = useListView({
  options: filterOptions,
  defaultValue: 'open',
  key: 'status',
})
const filter = statusView.value
const status = computed(() => filter.value as CategorySuggestionStatus)

const showAcceptDialog = ref(false)
const editing = ref<CategorySuggestion | null>(null)
const acceptName = ref('')
const acceptSlug = ref('')
const submitting = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [suggestionsRes, categoriesRes] = await Promise.all([
      listCategorySuggestions(status.value),
      categoriesBySlug.value.size === 0 ? listDocumentCategories() : Promise.resolve(null),
    ])
    items.value = suggestionsRes.items
    if (categoriesRes) {
      const map = new Map<string, DocumentCategory>()
      for (const c of categoriesRes.items) map.set(c.slug, c)
      categoriesBySlug.value = map
    }
  } catch (err: any) {
    error.value = err.message || 'Vorschläge konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}

watch(filter, load)

const toolbar = useListToolbar({
  result: {
    // The endpoint returns the whole status bucket at once.
    loaded: () => items.value.length,
    loading: () => loading.value,
  },
})

/** One wording per status — an empty "Offen" means something else than an empty "Abgelehnt". */
const emptyState = computed(() => {
  if (status.value === 'open') {
    return { title: 'Keine offenen Vorschläge', message: 'Die Taxonomie ist aktuell.' }
  }
  if (status.value === 'accepted') {
    return { title: 'Noch keine Vorschläge akzeptiert', message: undefined }
  }
  return { title: 'Noch keine Vorschläge abgelehnt', message: undefined }
})

function parentLabel(slug: string | null): string {
  if (!slug) return 'Wurzel'
  return categoriesBySlug.value.get(slug)?.name ?? slug
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function openAccept(s: CategorySuggestion) {
  editing.value = s
  acceptName.value = s.suggested_name
  acceptSlug.value = slugify(s.suggested_name)
  showAcceptDialog.value = true
}

const slugCollision = computed(() => {
  if (!acceptSlug.value) return false
  return categoriesBySlug.value.has(acceptSlug.value)
})

async function confirmAccept() {
  if (!editing.value) return
  const name = acceptName.value.trim()
  const slug = acceptSlug.value.trim()
  if (!name || !slug) return
  submitting.value = true
  error.value = ''
  info.value = ''
  try {
    await acceptCategorySuggestion(editing.value.id, { name, slug })
    info.value = `Kategorie "${name}" angelegt.`
    showAcceptDialog.value = false
    editing.value = null
    // The new category invalidates the cached map.
    categoriesBySlug.value = new Map()
    await load()
  } catch (err: any) {
    error.value = err.message || 'Akzeptieren fehlgeschlagen'
  } finally {
    submitting.value = false
  }
}

async function reject(s: CategorySuggestion) {
  if (!window.confirm(`Vorschlag "${s.suggested_name}" ablehnen?`)) return
  error.value = ''
  info.value = ''
  try {
    await rejectCategorySuggestion(s.id)
    info.value = 'Vorschlag abgelehnt.'
    await load()
  } catch (err: any) {
    error.value = err.message || 'Ablehnen fehlgeschlagen'
  }
}

function openExample(documentId: number) {
  router.push({ name: 'dokumente-detail', params: { id: documentId } })
}

onMounted(load)
</script>

<template>
  <PageLayout title="Kategorie-Vorschläge" width="normal" :ready="!loading">
    <template #toolbar>
      <ListToolbar :model="toolbar">
        <template #actions>
          <SelectButton
            v-model="filter"
            :options="filterOptions"
            optionLabel="label"
            optionValue="value"
            :allowEmpty="false"
            size="small"
            v-tooltip.bottom="'Status'"
          />
        </template>
      </ListToolbar>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = ''" />
      <Message v-if="info" severity="success" @close="info = ''">{{ info }}</Message>
    </template>

    <div class="content">
    <p class="hint">
      Die KI schlägt neue Kategorien vor, wenn Dokumente nicht sicher in die
      bestehende Taxonomie fallen. Akzeptierte Vorschläge legen einen neuen
      Eintrag in der Kategorie-Hierarchie an.
    </p>

    <PageSkeleton v-if="loading && items.length === 0" variant="list" :count="5" />

    <EmptyState
      v-else-if="items.length === 0"
      icon="pi pi-folder-open"
      :title="emptyState.title"
      :message="emptyState.message"
    />

    <div v-else class="suggestion-list">
      <div v-for="s in items" :key="s.id" class="suggestion-card">
        <div class="suggestion-head">
          <h2 class="suggestion-name">
            <i class="pi pi-folder-open" /> {{ s.suggested_name }}
          </h2>
          <Tag
            v-if="s.status !== 'open'"
            :severity="s.status === 'accepted' ? 'success' : 'secondary'"
            :value="s.status === 'accepted' ? 'Akzeptiert' : 'Abgelehnt'"
          />
          <span v-if="s.created_at" class="suggestion-date">{{ formatDate(s.created_at) }}</span>
        </div>

        <div class="suggestion-meta">
          <span><strong>Eltern:</strong> {{ parentLabel(s.parent_slug) }}</span>
        </div>

        <p v-if="s.rationale" class="rationale">
          <i class="pi pi-info-circle" /> {{ s.rationale }}
        </p>

        <div v-if="s.example_document_ids.length > 0" class="examples">
          <span class="label">Beispiel-Dokumente:</span>
          <Button
            v-for="docId in s.example_document_ids"
            :key="docId"
            :label="`#${docId}`"
            size="small"
            text
            icon="pi pi-external-link"
            @click="openExample(docId)"
          />
        </div>

        <div v-if="s.status === 'open'" class="actions">
          <Button
            label="Akzeptieren"
            icon="pi pi-check"
            severity="success"
            :disabled="!auth.hasPermission('documents.manage_taxonomy')"
            @click="openAccept(s)"
          />
          <Button
            label="Ablehnen"
            icon="pi pi-times"
            severity="secondary"
            text
            :disabled="!auth.hasPermission('documents.manage_taxonomy')"
            @click="reject(s)"
          />
        </div>
      </div>
    </div>
    </div>

    <Dialog
    class="dialog-sm"
      v-model:visible="showAcceptDialog"
      header="Kategorie anlegen"
      modal
    >
      <div class="dialog-form">
        <label>
          <span class="label">Name</span>
          <InputText v-model="acceptName" autofocus />
        </label>
        <label>
          <span class="label">Slug</span>
          <InputText v-model="acceptSlug" />
          <small v-if="slugCollision" class="warn">
            <i class="pi pi-exclamation-triangle" />
            Slug existiert bereits — die bestehende Kategorie wird wiederverwendet.
          </small>
        </label>
        <p v-if="editing?.parent_slug" class="dialog-hint">
          Wird unterhalb von <strong>{{ parentLabel(editing.parent_slug) }}</strong> angelegt.
        </p>
        <p v-else class="dialog-hint">Wird auf der obersten Ebene angelegt.</p>
      </div>
      <template #footer>
        <Button label="Abbrechen" text @click="showAcceptDialog = false" />
        <Button
          label="Anlegen"
          icon="pi pi-check"
          :loading="submitting"
          :disabled="!acceptName.trim() || !acceptSlug.trim()"
          @click="confirmAccept"
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
  gap: 1rem;
}

.hint {
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
  margin: 0;
}

.suggestion-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.suggestion-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
}

.suggestion-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.suggestion-name {
  font-size: var(--text-xl);
  font-weight: 600;
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.suggestion-date {
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
  margin-left: auto;
}

.suggestion-meta {
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}

.rationale {
  margin: 0;
  font-size: var(--text-base);
  display: inline-flex;
  align-items: flex-start;
  gap: 0.4rem;
}

.examples {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.label {
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.dialog-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.dialog-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.dialog-hint {
  margin: 0;
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}
.warn {
  color: var(--p-orange-600);
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: var(--text-base);
}
</style>
