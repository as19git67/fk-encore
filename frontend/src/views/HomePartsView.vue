<script setup lang="ts">
/**
 * Haus › Ersatzteile — the household's spare parts and consumables: what
 * fits which system, where it is stored and how many are left
 * (documentation/plans/haus-anlagen.md, stage 3). A part with none left is
 * marked; "Keins mehr da" shows only those.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import ToggleButton from 'primevue/togglebutton'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import HomePartDialog from '../components/home/HomePartDialog.vue'
import { useListSearch, useListToolbar, useListView, type FilterChip } from '../composables/useListToolbar'
import { useAuthStore } from '../stores/auth'
import { anchorKey, saveListAnchor } from '../utils/listAnchor'
import { homeMediaUrl, listHomeParts, stockLabel, type HomePartListItem } from '../api/home'

const ANCHOR_KEY = 'haus-ersatzteile'

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('home.manage'))

const parts = ref<HomePartListItem[]>([])
const loading = ref(true)
const loadError = ref('')
const createOpen = ref(false)

const search = useListSearch({ placeholder: 'Teil, Nummer, Lagerort…', storageKey: 'home.parts.search' })

const stockView = useListView({
  options: [
    { label: 'Alle', value: 'all' },
    { label: 'Keins mehr da', value: 'empty' },
  ],
  defaultValue: 'all',
  key: 'stock',
})
const stock = stockView.value
const onlyEmpty = computed({
  get: () => stock.value === 'empty',
  set: (on: boolean) => { stock.value = on ? 'empty' : 'all' },
})

const filterChips = computed<FilterChip[]>(() =>
  stock.value === 'empty'
    ? [{ key: 'stock', label: 'Keins mehr da', remove: () => { stock.value = 'all' } }]
    : [],
)

const toolbar = useListToolbar({
  search,
  filter: {
    chips: filterChips,
    activeCount: () => filterChips.value.length,
    clearAll: () => { stock.value = 'all' },
  },
  result: {
    loaded: () => parts.value.length,
    total: () => undefined,
    loading: () => loading.value,
  },
})

const filtered = computed(() => filterChips.value.length > 0 || !!search.term.value)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    parts.value = (await listHomeParts({ q: search.term.value || undefined, empty: stock.value === 'empty' })).parts
  } catch (err: any) {
    loadError.value = err?.message ?? 'Ersatzteile konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

watch([() => search.term.value, stock], () => void load())

function open(part: Pick<HomePartListItem, 'id'>) {
  saveListAnchor(ANCHOR_KEY, { kind: 'home-part', id: part.id })
  void router.push({ name: 'haus-ersatzteil', params: { id: part.id } })
}

function onCreated(id: number) {
  createOpen.value = false
  open({ id })
}

function identity(p: HomePartListItem): string {
  return [p.manufacturer, p.partNumber].filter(Boolean).join(' · ')
}

onMounted(load)
</script>

<template>
  <PageLayout
    title="Ersatzteile"
    hint="Was zu welcher Anlage passt, wo es liegt und wie viel noch da ist."
    width="wide"
    :ready="!loading"
    :anchor-key="ANCHOR_KEY"
  >
    <template #actions>
      <Button v-if="canManage" icon="pi pi-plus" label="Neues Ersatzteil" @click="createOpen = true" />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar">
        <template #actions>
          <ToggleButton
            v-model="onlyEmpty"
            on-label="Keins mehr da"
            off-label="Keins mehr da"
            on-icon="pi pi-exclamation-circle"
            off-icon="pi pi-exclamation-circle"
            size="small"
            aria-label="Nur Teile, von denen keins mehr da ist"
          />
        </template>
      </ListToolbar>
    </template>

    <template #notice>
      <ErrorBanner v-if="loadError" :message="loadError" closable @retry="load" @close="loadError = ''" />
    </template>

    <PageSkeleton v-if="loading && parts.length === 0" variant="list" :count="6" />

    <EmptyState
      v-else-if="parts.length === 0 && !loadError"
      icon="pi pi-box"
      :title="filtered ? 'Kein Ersatzteil passt dazu' : 'Noch kein Ersatzteil angelegt'"
      :message="filtered
        ? (onlyEmpty ? 'Von allen Teilen ist noch etwas da.' : 'Andere Wörter finden vielleicht mehr.')
        : 'Leg Dichtungen, Filter und andere Teile an, mit Lagerort und Bestand, und ordne sie den Anlagen zu.'"
      :filtered="filtered"
      @clear-filters="() => { search.clear(); stock = 'all' }"
    />

    <ul v-else class="part-grid" aria-label="Ersatzteile">
      <li
        v-for="p in parts"
        :key="p.id"
        :data-anchor="anchorKey('home-part', p.id)"
        class="part-card scroll-anchor"
        tabindex="0"
        role="link"
        :aria-label="p.name"
        @click="open(p)"
        @keydown.enter="open(p)"
        @keydown.space.prevent="open(p)"
      >
        <div class="part-head">
          <div class="part-title">
            <span class="part-name">{{ p.name }}</span>
            <span v-if="identity(p)" class="part-sub">{{ identity(p) }}</span>
          </div>
          <img
            v-if="p.coverMediaId"
            :src="homeMediaUrl(p.coverMediaId, 'small')"
            alt=""
            loading="lazy"
            class="part-cover"
          />
        </div>
        <span v-if="p.specification" class="part-spec">{{ p.specification }}</span>
        <span v-if="p.storageLocation" class="part-line">
          <i class="pi pi-map-marker" aria-hidden="true" /> {{ p.storageLocation }}
        </span>
        <span class="part-line">
          <Tag v-if="p.stock === 0" severity="warn" :value="stockLabel(p.stock)" icon="pi pi-exclamation-circle" />
          <template v-else><i class="pi pi-box" aria-hidden="true" /> {{ stockLabel(p.stock) }}</template>
        </span>
        <span v-if="p.systems.length" class="part-line">
          <i class="pi pi-wrench" aria-hidden="true" /> {{ p.systems.map((s) => s.name).join(', ') }}
        </span>
      </li>
    </ul>

    <HomePartDialog v-if="createOpen" v-model:visible="createOpen" @saved="onCreated" />
  </PageLayout>
</template>

<style scoped>
.part-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
  gap: var(--space-3);
}
.part-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-background);
  cursor: pointer;
  min-width: 0;
}
.part-card:hover {
  background: var(--p-content-hover-background);
}
.part-card:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.part-head {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}
.part-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.part-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.part-cover {
  margin-left: auto;
  flex: 0 0 auto;
  width: 3.5rem;
  height: 3.5rem;
  object-fit: cover;
  border-radius: 6px;
  background: var(--p-content-hover-background);
}
.part-sub,
.part-line {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.part-spec {
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.part-line i {
  font-size: 0.85em;
}
</style>
