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
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import CollectionTile from '../components/collections/CollectionTile.vue'
import CollectionActions from '../components/collections/CollectionActions.vue'
import { collectionTypeLabel } from '../components/collections/collectionLabels'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Checkbox from 'primevue/checkbox'
import MultiSelect from 'primevue/multiselect'
import SelectButton from 'primevue/selectbutton'
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
import { getOverview } from '../api/finance'
import {
  ENTITY_LABELS,
  createRuleCollection,
  type MemberRuleInput,
  createAnyCollection,
  describeCounts,
  listAllCollections,
  markCollectionOpened,
  type CollectionEntityType,
  type CollectionSummary,
} from '../api/collections'
import { collectionRoute } from '../utils/collectionRoute'
import { anchorKey, saveListAnchor } from '../utils/listAnchor'
import { updateRouteQuery } from '../utils/routeQueryUpdate'

const ANCHOR_KEY = 'sammelmappen'
const route = useRoute()
const router = useRouter()

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
// The tile, its star and its "⋮" menu are shared with the document list and
// Dokumente › Sammelmappen (components/collections/CollectionTile.vue,
// CollectionActions.vue); this page only opens folders and reloads.

const notice = ref('')
const actions = ref<InstanceType<typeof CollectionActions> | null>(null)

function open(c: CollectionSummary) {
  saveListAnchor(ANCHOR_KEY, { kind: 'collection', id: c.id })
  void markCollectionOpened(c.id).catch(() => { /* the visit is a hint, not a must */ })
  void router.push(collectionRoute(c))
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
// Meters and securities can fill themselves from the start; photos and
// transactions get their rule from their list's filter ("Als Regel-Mappe").
const createWithRule = ref(false)
const ruleMeterTypes = ref<Array<'electricity' | 'water' | 'gas' | 'operating_hours'>>([])
const ruleLocation = ref('')
const ruleDepots = ref<number[]>([])
const depotOptions = ref<Array<{ id: number; label: string }>>([])
const METER_TYPE_OPTIONS = [
  { label: 'Strom', value: 'electricity' },
  { label: 'Wasser', value: 'water' },
  { label: 'Gas', value: 'gas' },
  { label: 'Betriebsstunden', value: 'operating_hours' },
]
const ruleCapable = computed(() => createType.value === 'meter' || createType.value === 'security')
watch(createType, async (type) => {
  createWithRule.value = false
  if (type !== 'security' || depotOptions.value.length) return
  try {
    const overview = await getOverview()
    const accounts = [...overview.sections.flatMap((s) => s.accounts), ...overview.unassigned]
    depotOptions.value = accounts.filter((a) => a.type_kind === 'depot').map((a) => ({ id: a.id, label: a.label }))
  } catch {
    depotOptions.value = []
  }
})
const createRule = computed<MemberRuleInput | null>(() => {
  if (!createWithRule.value) return null
  if (createType.value === 'meter') {
    const location = ruleLocation.value.trim()
    if (!ruleMeterTypes.value.length && !location) return null
    return { type: 'meter', criteria: { meter_types: ruleMeterTypes.value, ...(location ? { location } : {}) } }
  }
  if (createType.value === 'security') {
    return { type: 'security', criteria: ruleDepots.value.length ? { account_ids: ruleDepots.value } : {} }
  }
  return null
})

async function create() {
  const name = createName.value.trim()
  if (!name) return
  try {
    if (createWithRule.value) {
      if (!createRule.value) {
        error.value = 'Die Regel braucht mindestens eine Bedingung.'
        return
      }
      const res = await createRuleCollection({ name, rule: createRule.value })
      createOpen.value = false
      createName.value = ''
      createType.value = ''
      open(res.collection)
      return
    }
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
      <Message v-if="notice" severity="success" closable @close="notice = ''">{{ notice }}</Message>
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
      <CollectionTile
        v-for="c in ordered"
        :key="c.id"
        :collection="c"
        @open="open"
        @toggle-favourite="actions?.toggleFavourite($event)"
        @menu="(event, collection) => actions?.openMenu(event, collection)"
      />
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
                @click="actions?.toggleFavourite(c)"
              />
            </td>
            <td>
              <button type="button" class="collections-table-link" @click="open(c)">{{ c.name }}</button>
            </td>
            <td>{{ collectionTypeLabel(c) }}</td>
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
                @click="actions?.openMenu($event, c)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </ScrollX>

    <CollectionActions
      ref="actions"
      @changed="load"
      @error="(message) => (error = message)"
      @notice="(message) => (notice = message)"
    />

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
      <label v-if="ruleCapable" class="collections-check">
        <Checkbox v-model="createWithRule" binary />
        <span>Automatisch füllen (Regel)</span>
      </label>
      <template v-if="createWithRule && createType === 'meter'">
        <label class="collections-field">
          <span>Zählerarten</span>
          <MultiSelect
            v-model="ruleMeterTypes"
            :options="METER_TYPE_OPTIONS"
            option-label="label"
            option-value="value"
            placeholder="Alle Arten"
            display="chip"
          />
        </label>
        <label class="collections-field">
          <span>Ort enthält</span>
          <InputText v-model="ruleLocation" class="collections-input" placeholder="z. B. Keller" />
        </label>
      </template>
      <label v-if="createWithRule && createType === 'security'" class="collections-field">
        <span>Depots</span>
        <MultiSelect
          v-model="ruleDepots"
          :options="depotOptions"
          option-label="label"
          option-value="id"
          placeholder="Alle Depots"
          display="chip"
        />
      </label>
      <p v-if="createType === 'photo' || createType === 'transaction'" class="collections-note">
        Fotos und Buchungen bekommen ihre Regel aus dem Filter ihrer Liste: dort „Als Regel-Mappe“.
      </p>
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
.collections-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
}
.collections-note {
  margin: 0 0 var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
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
