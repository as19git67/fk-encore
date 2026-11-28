<script setup lang="ts">
/**
 * Haus › Anlagen — the technical systems of the house, each with its guides,
 * items in place and notes (documentation/plans/haus-anlagen.md).
 *
 * The search goes to the server: it looks into guides, items and notes too,
 * and the card says where it found the term.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Select from 'primevue/select'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import HomeSystemDialog from '../components/home/HomeSystemDialog.vue'
import { useListSearch, useListToolbar, useListView, type FilterChip } from '../composables/useListToolbar'
import { useAuthStore } from '../stores/auth'
import { anchorKey, saveListAnchor } from '../utils/listAnchor'
import {
  HOME_CATEGORY_ICONS,
  HOME_CATEGORY_LABELS,
  homeMediaUrl,
  listHomeSystems,
  type HomeSystemCategory,
  type HomeSystemListItem,
} from '../api/home'
import { parseLocalDate } from '../utils/dateFormat'

/** One key for this list — anchor and scroll offset are stored under it. */
const ANCHOR_KEY = 'haus-anlagen'

const router = useRouter()
const auth = useAuthStore()
const canManage = computed(() => auth.hasPermission('home.manage'))

const systems = ref<HomeSystemListItem[]>([])
// True from the start: PageLayout restores the card on the way back once the
// page is ready, and an empty list before the first load has none to find.
const loading = ref(true)
const loadError = ref('')
const createOpen = ref(false)

const search = useListSearch({ placeholder: 'Anlagen, Anleitungen, Teile…', storageKey: 'home.systems.search' })

const categoryOptions = [
  { label: 'Alle Bereiche', value: 'all' },
  ...(Object.keys(HOME_CATEGORY_LABELS) as HomeSystemCategory[]).map((value) => ({
    label: HOME_CATEGORY_LABELS[value],
    value,
  })),
]
const categoryView = useListView({ options: categoryOptions, defaultValue: 'all', key: 'category' })
const category = categoryView.value

const stateOptions = [
  { label: 'In Betrieb', value: 'active' },
  { label: 'Archiviert', value: 'archived' },
]
const stateView = useListView({ options: stateOptions, defaultValue: 'active', key: 'state' })
const state = stateView.value

const filterChips = computed<FilterChip[]>(() => {
  const chips: FilterChip[] = []
  if (category.value !== 'all') {
    chips.push({
      key: 'category',
      label: `Bereich: ${HOME_CATEGORY_LABELS[category.value as HomeSystemCategory] ?? category.value}`,
      remove: () => { category.value = 'all' },
    })
  }
  if (state.value !== 'active') {
    chips.push({ key: 'state', label: 'Archiviert', remove: () => { state.value = 'active' } })
  }
  return chips
})

function clearFilters() {
  category.value = 'all'
  state.value = 'active'
}

const toolbar = useListToolbar({
  search,
  filter: {
    chips: filterChips,
    activeCount: () => filterChips.value.length,
    clearAll: clearFilters,
  },
  result: {
    loaded: () => systems.value.length,
    total: () => undefined,
    loading: () => loading.value,
  },
})

const filtered = computed(() => filterChips.value.length > 0 || !!search.term.value)

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await listHomeSystems({
      q: search.term.value || undefined,
      category: category.value === 'all' ? undefined : category.value,
      archived: state.value === 'archived',
    })
    systems.value = res.systems
  } catch (err: any) {
    loadError.value = err?.message ?? 'Anlagen konnten nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

watch([() => search.term.value, category, state], () => void load())

function open(system: Pick<HomeSystemListItem, 'id'>) {
  saveListAnchor(ANCHOR_KEY, { kind: 'home-system', id: system.id })
  void router.push({ name: 'haus-anlage', params: { id: system.id } })
}

function onCreated(id: number) {
  createOpen.value = false
  open({ id })
}

function subtitle(s: HomeSystemListItem): string {
  return [HOME_CATEGORY_LABELS[s.category], s.location].filter(Boolean).join(' · ')
}

function deviceLine(s: HomeSystemListItem): string {
  return [s.manufacturer, s.model].filter(Boolean).join(' ')
}

function contents(s: HomeSystemListItem): string {
  const parts: string[] = []
  if (s.guideCount) parts.push(s.guideCount === 1 ? '1 Anleitung' : `${s.guideCount} Anleitungen`)
  if (s.itemCount) parts.push(s.itemCount === 1 ? '1 Einzelteil' : `${s.itemCount} Einzelteile`)
  if (s.noteCount) parts.push(s.noteCount === 1 ? '1 Notiz' : `${s.noteCount} Notizen`)
  return parts.join(' · ') || 'Noch leer'
}

function lastNote(s: HomeSystemListItem): string | null {
  if (!s.lastNoteOn) return null
  return `Zuletzt ${parseLocalDate(s.lastNoteOn).toLocaleDateString('de-DE')}`
}

function sharingIcon(s: HomeSystemListItem): string {
  if (s.groupId === null) return 'pi pi-lock'
  return s.household ? 'pi pi-home' : 'pi pi-users'
}

function sharingLabel(s: HomeSystemListItem): string {
  const owner = s.ownerUserId === auth.user?.id ? '' : ` · von ${s.ownerName}`
  if (s.groupId === null) return `Privat${owner}`
  return `${s.household ? 'Haushalt' : 'Gruppe'} „${s.groupName ?? ''}“${owner}`
}

onMounted(load)
</script>

<template>
  <PageLayout
    title="Anlagen"
    hint="Wie die Technik im Haus gewartet wird, welche Teile passen und was zuletzt gemacht wurde."
    width="wide"
    :ready="!loading"
    :anchor-key="ANCHOR_KEY"
  >
    <template #actions>
      <Button v-if="canManage" icon="pi pi-plus" label="Neue Anlage" @click="createOpen = true" />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar">
        <template #actions>
          <Select
            v-model="category"
            :options="categoryOptions"
            option-label="label"
            option-value="value"
            size="small"
            aria-label="Bereich"
            class="filter-select"
          />
          <Select
            v-model="state"
            :options="stateOptions"
            option-label="label"
            option-value="value"
            size="small"
            aria-label="Zustand"
            class="filter-select"
          />
        </template>
      </ListToolbar>
    </template>

    <template #notice>
      <ErrorBanner v-if="loadError" :message="loadError" closable @retry="load" @close="loadError = ''" />
    </template>

    <PageSkeleton v-if="loading && systems.length === 0" variant="list" :count="6" />

    <EmptyState
      v-else-if="systems.length === 0 && !loadError"
      icon="pi pi-wrench"
      :title="filtered ? 'Keine Anlage passt dazu' : 'Noch keine Anlage angelegt'"
      :message="filtered
        ? 'Andere Wörter oder ein anderer Bereich finden vielleicht mehr.'
        : 'Lege die erste Anlage an, etwa die Heizung oder die Enthärtungsanlage, und schreib auf, wie sie gewartet wird.'"
      :filtered="filtered"
      @clear-filters="() => { search.clear(); clearFilters() }"
    />

    <ul v-else class="system-grid" aria-label="Anlagen">
      <li
        v-for="s in systems"
        :key="s.id"
        :data-anchor="anchorKey('home-system', s.id)"
        class="system-card scroll-anchor"
        tabindex="0"
        role="link"
        :aria-label="s.name"
        @click="open(s)"
        @keydown.enter="open(s)"
        @keydown.space.prevent="open(s)"
      >
        <div class="system-head">
          <i :class="HOME_CATEGORY_ICONS[s.category]" class="system-icon" aria-hidden="true" />
          <div class="system-title">
            <span class="system-name">{{ s.name }}</span>
            <span class="system-sub">{{ subtitle(s) }}</span>
          </div>
          <img
            v-if="s.coverMediaId"
            :src="homeMediaUrl(s.coverMediaId, 'small')"
            alt=""
            loading="lazy"
            class="system-cover"
          />
        </div>
        <span v-if="deviceLine(s)" class="system-device">{{ deviceLine(s) }}</span>
        <span class="system-contents">
          {{ contents(s) }}<template v-if="lastNote(s)"> · {{ lastNote(s) }}</template>
        </span>
        <ul v-if="s.matches.length" class="system-matches" aria-label="Fundstellen">
          <li v-for="m in s.matches" :key="m"><i class="pi pi-search" aria-hidden="true" /> {{ m }}</li>
        </ul>
        <span class="system-sharing"><i :class="sharingIcon(s)" aria-hidden="true" /> {{ sharingLabel(s) }}</span>
      </li>
    </ul>

    <HomeSystemDialog v-if="createOpen" v-model:visible="createOpen" @saved="onCreated" />
  </PageLayout>
</template>

<style scoped>
.filter-select {
  min-width: 9rem;
}
.system-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
  gap: var(--space-3);
}
.system-card {
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
.system-card:hover {
  background: var(--p-content-hover-background);
}
.system-card:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.system-cover {
  margin-left: auto;
  flex: 0 0 auto;
  width: 3.5rem;
  height: 3.5rem;
  object-fit: cover;
  border-radius: 6px;
  background: var(--p-content-hover-background);
}
.system-head {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}
.system-icon {
  font-size: var(--text-xl);
  color: var(--p-primary-color);
  margin-top: 2px;
}
.system-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.system-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.system-sub,
.system-device,
.system-contents,
.system-sharing {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.system-device {
  color: var(--p-text-color);
}
.system-matches {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--text-sm);
}
.system-matches i {
  font-size: 0.8em;
  color: var(--p-text-muted-color);
}
</style>
