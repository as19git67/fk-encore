<script setup lang="ts">
/**
 * Sammelmappen — every collection of every type in one list (#1548, stage 3).
 *
 * A hundred folders help nobody as a flat list, so this page is a list like
 * any other: search over name and description, filters for type, archive,
 * favourites and who made it, sort by last visit, change, name or size, and
 * tiles or a table. Starred folders stand first. Opening a folder goes where
 * it belongs: a typed one to its module's list, limited to its members; a
 * mixed one to the generic collection page.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import SelectButton from 'primevue/selectbutton'
import Tag from 'primevue/tag'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ScrollX from '../components/layout/ScrollX.vue'
import type { FilterChip } from '../components/layout/listToolbar'
import { useListSearch, useListToolbar, useListView } from '../composables/useListToolbar'
import { useSort } from '../composables/useSort'
import { rememberCollectionName } from '../composables/useCollectionNames'
import {
  ENTITY_LABELS,
  createAnyCollection,
  deleteAnyCollection,
  describeCounts,
  listAllCollections,
  markCollectionOpened,
  updateAnyCollection,
  type CollectionEntityType,
  type CollectionSummary,
} from '../api/collections'
import { collectionRoute } from '../utils/collectionRoute'
import { anchorKey, saveListAnchor } from '../utils/listAnchor'
import { updateRouteQuery } from '../utils/routeQueryUpdate'

const ANCHOR_KEY = 'sammelmappen'
const route = useRoute()
const router = useRouter()
const confirm = useConfirm()

const items = ref<CollectionSummary[]>([])
const loading = ref(true)
const loaded = ref(false)
const error = ref('')

// ── Search, sort, view ───────────────────────────────────────────────────────

const search = useListSearch({ placeholder: 'Sammelmappen durchsuchen…', storageKey: 'collections.search' })

const sort = useSort({
  fields: [
    { value: 'last_opened', label: 'Zuletzt geöffnet' },
    { value: 'updated', label: 'Zuletzt geändert' },
    { value: 'name', label: 'Name' },
    { value: 'count', label: 'Anzahl' },
  ],
  defaultState: { field: 'last_opened', direction: 'desc' },
  storageKey: 'collections.sort',
})

const view = useListView({
  options: [
    { value: 'tiles', label: 'Kacheln', icon: 'pi pi-th-large' },
    { value: 'table', label: 'Tabelle', icon: 'pi pi-list' },
  ],
  defaultValue: 'tiles',
  storageKey: 'collections.view',
})

// ── Filter (in the URL, like every list) ─────────────────────────────────────

type TypeFilter = CollectionEntityType | 'mixed' | ''
const TYPE_OPTIONS: Array<{ label: string; value: TypeFilter }> = [
  { label: 'Alle', value: '' },
  { label: 'Gemischt', value: 'mixed' },
  ...(Object.keys(ENTITY_LABELS) as CollectionEntityType[]).map((t) => ({ label: ENTITY_LABELS[t].plural, value: t })),
]
const STATE_OPTIONS = [
  { label: 'Aktiv', value: false },
  { label: 'Archiviert', value: true },
]
const BY_OPTIONS = [
  { label: 'Alle', value: '' },
  { label: 'Von mir', value: 'user' },
  { label: 'Vom Assistenten', value: 'assistant' },
]

const typeFilter = computed<TypeFilter>(() => {
  const t = route.query.type
  return typeof t === 'string' && TYPE_OPTIONS.some((o) => o.value === t) ? (t as TypeFilter) : ''
})
const archived = computed(() => route.query.archived === '1')
const favouriteOnly = computed(() => route.query.fav === '1')
const createdBy = computed(() => (route.query.by === 'user' || route.query.by === 'assistant' ? route.query.by : ''))

function setQuery(patch: Record<string, string | undefined>) {
  void updateRouteQuery(router, (current) => {
    const next = { ...current }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') delete next[k]
      else next[k] = v
    }
    return next
  })
}

const filterOpen = ref(false)
const activeCount = computed(
  () => Number(!!typeFilter.value) + Number(archived.value) + Number(favouriteOnly.value) + Number(!!createdBy.value),
)
const chips = computed<FilterChip[]>(() => {
  const out: FilterChip[] = []
  if (typeFilter.value) {
    out.push({
      key: 'type',
      label: `Typ: ${TYPE_OPTIONS.find((o) => o.value === typeFilter.value)?.label}`,
      remove: () => setQuery({ type: undefined }),
    })
  }
  if (archived.value) out.push({ key: 'archived', label: 'Archiviert', remove: () => setQuery({ archived: undefined }) })
  if (favouriteOnly.value) out.push({ key: 'fav', label: 'Nur Favoriten', remove: () => setQuery({ fav: undefined }) })
  if (createdBy.value) {
    out.push({
      key: 'by',
      label: createdBy.value === 'assistant' ? 'Vom Assistenten' : 'Von mir angelegt',
      remove: () => setQuery({ by: undefined }),
    })
  }
  return out
})
function clearFilters() {
  setQuery({ type: undefined, archived: undefined, fav: undefined, by: undefined })
}

const toolbar = useListToolbar({
  search,
  filter: {
    chips,
    activeCount,
    open: () => (filterOpen.value = !filterOpen.value),
    expanded: filterOpen,
    clearAll: clearFilters,
  },
  sort,
  view,
  result: {
    loaded: () => items.value.length,
    loading: () => loading.value,
  },
})

// ── Loading ──────────────────────────────────────────────────────────────────

let generation = 0
async function load() {
  const run = ++generation
  loading.value = true
  error.value = ''
  try {
    const res = await listAllCollections({
      q: search.term.value.trim() || undefined,
      type: typeFilter.value || undefined,
      archived: archived.value || undefined,
      favourite: favouriteOnly.value || undefined,
      created_by: createdBy.value || undefined,
      sort: sort.applied.value.field as 'last_opened' | 'updated' | 'name' | 'count',
      dir: sort.applied.value.direction,
    } as Parameters<typeof listAllCollections>[0])
    if (run !== generation) return
    items.value = res.items
    for (const c of res.items) rememberCollectionName(c.id, c.name)
  } catch (err: unknown) {
    if (run !== generation) return
    error.value = err instanceof Error ? err.message : 'Sammelmappen konnten nicht geladen werden.'
  } finally {
    if (run === generation) {
      loading.value = false
      loaded.value = true
    }
  }
}

watch(
  () => [
    search.term.value,
    typeFilter.value,
    archived.value,
    favouriteOnly.value,
    createdBy.value,
    sort.applied.value.field,
    sort.applied.value.direction,
  ],
  () => void load(),
  { immediate: true },
)

/** Starred folders first, the chosen order kept within each part. */
const ordered = computed(() => [
  ...items.value.filter((c) => c.favourite),
  ...items.value.filter((c) => !c.favourite),
])

// ── Actions ──────────────────────────────────────────────────────────────────

function typeLabel(c: CollectionSummary): string {
  if (c.kind === 'dossier') return 'Akte'
  return c.entity_type ? ENTITY_LABELS[c.entity_type].plural : 'Gemischt'
}
function typeIcon(c: CollectionSummary): string {
  return c.entity_type ? ENTITY_LABELS[c.entity_type].icon : 'pi pi-folder'
}

function open(c: CollectionSummary) {
  saveListAnchor(ANCHOR_KEY, { kind: 'collection', id: c.id })
  void markCollectionOpened(c.id).catch(() => { /* the visit is a hint, not a must */ })
  void router.push(collectionRoute(c))
}

async function toggleFavourite(c: CollectionSummary) {
  const next = !c.favourite
  c.favourite = next
  try {
    await updateAnyCollection(c.id, { favourite: next })
  } catch (err: unknown) {
    c.favourite = !next
    error.value = err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'
  }
}

async function setArchived(c: CollectionSummary, value: boolean) {
  try {
    await updateAnyCollection(c.id, { archived: value })
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'
  }
}

function askDelete(c: CollectionSummary) {
  confirm.require({
    header: 'Sammelmappe löschen?',
    message: `„${c.name}“ wird gelöscht. Was darin liegt, bleibt erhalten.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Löschen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: () => {
      void deleteAnyCollection(c.id)
        .then(load)
        .catch((err: unknown) => {
          error.value = err instanceof Error ? err.message : 'Löschen fehlgeschlagen.'
        })
    },
  })
}

// Rename, shared by every tile.
const renameTarget = ref<CollectionSummary | null>(null)
const renameValue = ref('')
function openRename(c: CollectionSummary) {
  renameTarget.value = c
  renameValue.value = c.name
}
async function saveRename() {
  const c = renameTarget.value
  const name = renameValue.value.trim()
  if (!c || !name) return
  try {
    await updateAnyCollection(c.id, { name })
    renameTarget.value = null
    await load()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Umbenennen fehlgeschlagen.'
  }
}

// One row menu for the whole page, filled for the row that opened it.
const rowMenu = ref<InstanceType<typeof Menu> | null>(null)
const rowMenuItems = ref<Array<{ label: string; icon: string; command: () => void }>>([])
function openRowMenu(event: Event, c: CollectionSummary) {
  const entries: Array<{ label: string; icon: string; command: () => void }> = [
    { label: 'Umbenennen', icon: 'pi pi-pencil', command: () => openRename(c) },
  ]
  if (c.can_administer) {
    entries.push(
      c.archived_at
        ? { label: 'Zurückholen', icon: 'pi pi-replay', command: () => void setArchived(c, false) }
        : { label: 'Archivieren', icon: 'pi pi-box', command: () => void setArchived(c, true) },
      { label: 'Löschen', icon: 'pi pi-trash', command: () => askDelete(c) },
    )
  }
  rowMenuItems.value = entries
  rowMenu.value?.toggle(event)
}

// New collection, made here and opened at once.
const createOpen = ref(false)
const createName = ref('')
const createType = ref<CollectionEntityType | ''>('')
const CREATE_TYPES = [
  { label: 'Gemischt', value: '' },
  ...(Object.keys(ENTITY_LABELS) as CollectionEntityType[])
    .filter((t) => t !== 'meter_reading')
    .map((t) => ({ label: ENTITY_LABELS[t].plural, value: t })),
]
async function create() {
  const name = createName.value.trim()
  if (!name) return
  try {
    const created = await createAnyCollection({ name, entity_type: createType.value || null })
    createOpen.value = false
    createName.value = ''
    createType.value = ''
    open(created)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Anlegen fehlgeschlagen.'
  }
}

const filtered = computed(() => activeCount.value > 0 || !!search.term.value.trim())
</script>

<template>
  <PageLayout
    title="Sammelmappen"
    hint="Was zusammengehört, über Fotos, Dokumente, Buchungen, Wertpapiere und Zähler hinweg."
    width="wide"
    :ready="loaded"
    :anchor-key="ANCHOR_KEY"
  >
    <template #actions>
      <Button label="Neue Sammelmappe" icon="pi pi-plus" data-testid="collections-new" @click="createOpen = true" />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
      <div v-if="filterOpen" class="collections-filter" data-testid="collections-filter">
        <label class="collections-filter-field">
          <span>Typ</span>
          <SelectButton
            :model-value="typeFilter"
            :options="TYPE_OPTIONS"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            @update:model-value="(v: TypeFilter) => setQuery({ type: v || undefined })"
          />
        </label>
        <label class="collections-filter-field">
          <span>Stand</span>
          <SelectButton
            :model-value="archived"
            :options="STATE_OPTIONS"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            @update:model-value="(v: boolean) => setQuery({ archived: v ? '1' : undefined })"
          />
        </label>
        <label class="collections-filter-field">
          <span>Angelegt</span>
          <SelectButton
            :model-value="createdBy"
            :options="BY_OPTIONS"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            @update:model-value="(v: string) => setQuery({ by: v || undefined })"
          />
        </label>
        <Button
          :label="favouriteOnly ? 'Alle zeigen' : 'Nur Favoriten'"
          :icon="favouriteOnly ? 'pi pi-star-fill' : 'pi pi-star'"
          severity="secondary"
          outlined
          :aria-pressed="favouriteOnly"
          @click="setQuery({ fav: favouriteOnly ? undefined : '1' })"
        />
      </div>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = ''" />
    </template>

    <PageSkeleton v-if="loading && !loaded" />
    <EmptyState
      v-else-if="ordered.length === 0"
      icon="pi pi-folder-open"
      :title="filtered ? 'Keine passende Sammelmappe' : archived ? 'Nichts archiviert' : 'Noch keine Sammelmappe'"
      :message="filtered ? undefined : 'Lege Dinge aus jeder Liste in den Basket und speichere ihn als Sammelmappe, oder lege hier eine an.'"
      :filtered="filtered"
      @clear-filters="clearFilters(); search.clear?.()"
    />

    <ul v-else-if="view.value.value === 'tiles'" class="collections-grid" data-testid="collections-tiles">
      <li
        v-for="c in ordered"
        :key="c.id"
        class="collection-tile scroll-anchor"
        :data-anchor="anchorKey('collection', c.id)"
      >
        <button type="button" class="collection-tile-body" :aria-label="`Öffnen: ${c.name}`" @click="open(c)">
          <span class="collection-tile-icon"><i :class="typeIcon(c)" aria-hidden="true" /></span>
          <span class="collection-tile-name">{{ c.name }}</span>
          <span class="collection-tile-meta">{{ describeCounts(c.counts) || 'leer' }}</span>
          <span class="collection-tile-tags">
            <Tag :value="typeLabel(c)" severity="secondary" />
            <Tag v-if="c.visibility === 'group'" value="Gruppe" icon="pi pi-users" severity="info" />
            <Tag v-if="c.created_by === 'assistant'" value="Assistent" icon="pi pi-sparkles" severity="info" />
            <Tag v-if="c.archived_at" value="Archiviert" icon="pi pi-box" severity="secondary" />
          </span>
        </button>
        <div class="collection-tile-actions">
          <Button
            :icon="c.favourite ? 'pi pi-star-fill' : 'pi pi-star'"
            text
            rounded
            size="small"
            :severity="c.favourite ? 'warn' : 'secondary'"
            :aria-label="c.favourite ? `Favorit entfernen: ${c.name}` : `Als Favorit markieren: ${c.name}`"
            :aria-pressed="c.favourite"
            @click="toggleFavourite(c)"
          />
          <Button
            icon="pi pi-ellipsis-v"
            text
            rounded
            size="small"
            severity="secondary"
            :aria-label="`Weitere Aktionen: ${c.name}`"
            aria-haspopup="true"
            @click="openRowMenu($event, c)"
          />
        </div>
      </li>
    </ul>

    <ScrollX v-else>
      <table class="collections-table" data-testid="collections-table">
        <thead>
          <tr>
            <th><span class="visually-hidden">Favorit</span></th>
            <th>Name</th>
            <th>Typ</th>
            <th>Inhalt</th>
            <th>Geändert</th>
            <th><span class="visually-hidden">Aktionen</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in ordered"
            :key="c.id"
            class="scroll-anchor"
            :data-anchor="anchorKey('collection', c.id)"
          >
            <td>
              <Button
                :icon="c.favourite ? 'pi pi-star-fill' : 'pi pi-star'"
                text
                rounded
                size="small"
                :severity="c.favourite ? 'warn' : 'secondary'"
                :aria-label="c.favourite ? `Favorit entfernen: ${c.name}` : `Als Favorit markieren: ${c.name}`"
                :aria-pressed="c.favourite"
                @click="toggleFavourite(c)"
              />
            </td>
            <td>
              <button type="button" class="collections-table-link" @click="open(c)">{{ c.name }}</button>
            </td>
            <td>{{ typeLabel(c) }}</td>
            <td>{{ describeCounts(c.counts) || 'leer' }}</td>
            <td>{{ new Date(c.updated_at).toLocaleDateString('de-DE') }}</td>
            <td>
              <Button
                icon="pi pi-ellipsis-v"
                text
                rounded
                size="small"
                severity="secondary"
                :aria-label="`Weitere Aktionen: ${c.name}`"
                aria-haspopup="true"
                @click="openRowMenu($event, c)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </ScrollX>

    <Menu ref="rowMenu" :model="rowMenuItems" popup />

    <Dialog
      class="dialog-sm"
      :visible="renameTarget !== null"
      modal
      header="Sammelmappe umbenennen"
      @update:visible="(v: boolean) => { if (!v) renameTarget = null }"
    >
      <InputText v-model="renameValue" autofocus class="collections-input" aria-label="Neuer Name" @keyup.enter="saveRename" />
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="renameTarget = null" />
        <Button label="Speichern" icon="pi pi-check" :disabled="!renameValue.trim()" @click="saveRename" />
      </template>
    </Dialog>

    <Dialog v-model:visible="createOpen" class="dialog-sm" modal header="Neue Sammelmappe">
      <label class="collections-field">
        <span>Name</span>
        <InputText v-model="createName" autofocus class="collections-input" data-testid="collections-new-name" @keyup.enter="create" />
      </label>
      <label class="collections-field">
        <span>Was hineindarf</span>
        <SelectButton
          v-model="createType"
          :options="CREATE_TYPES"
          option-label="label"
          option-value="value"
          :allow-empty="false"
        />
      </label>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="createOpen = false" />
        <Button label="Anlegen" icon="pi pi-plus" :disabled="!createName.trim()" @click="create" />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.collections-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
  padding: var(--space-3) var(--page-gutter);
  border-top: 1px solid var(--p-content-border-color);
}
.collections-filter-field,
.collections-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.collections-field {
  margin-bottom: var(--space-3);
}
.collections-filter :deep(.p-selectbutton) {
  flex-wrap: wrap;
}
.collections-input {
  width: 100%;
}
.collections-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: var(--space-3);
}
.collection-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-background);
}
.collection-tile-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-3);
  padding-right: calc(var(--space-3) + 4.5rem);
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--p-text-color);
  text-align: left;
  font: inherit;
  cursor: pointer;
  min-width: 0;
}
.collection-tile-body:hover {
  background: var(--p-content-hover-background);
}
.collection-tile-body:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.collection-tile-icon {
  color: var(--p-primary-color);
  font-size: var(--text-xl);
}
.collection-tile-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.collection-tile-meta {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.collection-tile-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
.collection-tile-actions {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
}
.collections-table {
  width: 100%;
  border-collapse: collapse;
}
.collections-table th,
.collections-table td {
  padding: var(--space-2);
  text-align: left;
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.collections-table-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: var(--p-primary-color);
  cursor: pointer;
}
.collections-table-link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
