<script setup lang="ts">
/**
 * One collection that is not a single module's list (#1548, stage 3): a mixed
 * one, or one of securities or meter readings.
 *
 * Members are grouped by type, each group with the way into its module's own
 * list ("Als Liste öffnen"), where the module's columns, filters and batch
 * actions apply. Search, type filter and sort work here as on every list.
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import PageLayout from '../components/layout/PageLayout.vue'
import ListToolbar from '../components/layout/ListToolbar.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import type { FilterChip } from '../components/layout/listToolbar'
import { useListSearch, useListToolbar } from '../composables/useListToolbar'
import { useSort } from '../composables/useSort'
import { rememberCollectionName } from '../composables/useCollectionNames'
import {
  ENTITY_LABELS,
  describeCounts,
  getAnyCollection,
  markCollectionOpened,
  removeAnyCollectionMember,
  updateAnyCollection,
  type CollectionDetail,
  type CollectionEntityType,
  type CollectionMember,
} from '../api/collections'
import { memberRoute, typeListRoute } from '../utils/collectionRoute'
import { parseLocalDate } from '../utils/dateFormat'
import { updateRouteQuery } from '../utils/routeQueryUpdate'

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))

const detail = ref<CollectionDetail | null>(null)
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    detail.value = await getAnyCollection(id.value)
    rememberCollectionName(detail.value.id, detail.value.name)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Sammelmappe konnte nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

watch(
  id,
  (next) => {
    if (!Number.isInteger(next) || next <= 0) return
    void load()
    void markCollectionOpened(next).catch(() => { /* a hint, not a must */ })
  },
  { immediate: true },
)

// ── Search, filter, sort ─────────────────────────────────────────────────────

const search = useListSearch({ placeholder: 'In der Sammelmappe suchen…' })
const sort = useSort({
  fields: [
    { value: 'added', label: 'Hinzugefügt' },
    { value: 'date', label: 'Datum' },
    { value: 'title', label: 'Titel' },
  ],
  defaultState: { field: 'added', direction: 'asc' },
})

const ORDER = Object.keys(ENTITY_LABELS) as CollectionEntityType[]
const typeFilter = computed<CollectionEntityType | null>(() => {
  const t = route.query.type
  return typeof t === 'string' && (ORDER as string[]).includes(t) ? (t as CollectionEntityType) : null
})
function setType(type: CollectionEntityType | null) {
  void updateRouteQuery(router, (current) => {
    const next = { ...current }
    if (type) next.type = type
    else delete next.type
    return next
  })
}

const typesPresent = computed(() => ORDER.filter((t) => detail.value?.members.some((m) => m.entity_type === t)))
const filterOpen = ref(false)
const chips = computed<FilterChip[]>(() =>
  typeFilter.value
    ? [{ key: 'type', label: `Nur ${ENTITY_LABELS[typeFilter.value].plural}`, remove: () => setType(null) }]
    : [],
)

const visible = computed<CollectionMember[]>(() => {
  const term = search.term.value.trim().toLocaleLowerCase('de')
  const members = (detail.value?.members ?? []).filter((m) => {
    if (typeFilter.value && m.entity_type !== typeFilter.value) return false
    if (!term) return true
    return [m.title, m.subtitle].some((v) => v?.toLocaleLowerCase('de').includes(term))
  })
  const { field, direction } = sort.applied.value
  const sign = direction === 'asc' ? 1 : -1
  const key = (m: CollectionMember): string =>
    field === 'title' ? m.title.toLocaleLowerCase('de') : field === 'date' ? (m.date ?? '') : m.added_at
  return [...members].sort((a, b) => sign * key(a).localeCompare(key(b), 'de'))
})

const groups = computed(() =>
  ORDER.map((type) => ({
    type,
    label: ENTITY_LABELS[type],
    members: visible.value.filter((m) => m.entity_type === type),
    list: detail.value ? typeListRoute(type, detail.value.id) : null,
  })).filter((g) => g.members.length > 0),
)

const toolbar = useListToolbar({
  search,
  filter: {
    chips,
    activeCount: computed(() => (typeFilter.value ? 1 : 0)),
    open: () => (filterOpen.value = !filterOpen.value),
    expanded: filterOpen,
    clearAll: () => setType(null),
  },
  sort,
  result: {
    loaded: () => visible.value.length,
    total: () => detail.value?.members.length,
    loading: () => loading.value,
  },
})

// ── Display and actions ──────────────────────────────────────────────────────

function formatDate(value: string | null): string {
  if (!value) return ''
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseLocalDate(value) : new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('de-DE')
}
function formatAmount(m: CollectionMember): string | null {
  if (m.amount == null) return null
  const value = Number(m.amount)
  if (!Number.isFinite(value)) return m.amount
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: m.currency ?? 'EUR' }).format(value)
}

function openMember(m: CollectionMember) {
  const to = memberRoute(m.entity_type, m.entity_id)
  if (to) void router.push(to)
}

async function remove(m: CollectionMember) {
  if (!detail.value) return
  try {
    detail.value = await removeAnyCollectionMember(detail.value.id, m)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Entfernen fehlgeschlagen.'
  }
}

async function toggleFavourite() {
  if (!detail.value) return
  try {
    detail.value = await updateAnyCollection(detail.value.id, { favourite: !detail.value.favourite })
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'
  }
}

function goBack() {
  if (window.history.state?.back) router.back()
  else void router.push({ name: 'sammelmappen' })
}

const filtered = computed(() => !!typeFilter.value || !!search.term.value.trim())
</script>

<template>
  <PageLayout
    :title="detail?.name ?? 'Sammelmappe'"
    :hint="detail ? describeCounts(detail.counts) || 'leer' : undefined"
    width="normal"
    :ready="!loading"
  >
    <template #actions>
      <Button icon="pi pi-arrow-left" text rounded aria-label="Zurück" @click="goBack" />
      <Button
        v-if="detail"
        :icon="detail.favourite ? 'pi pi-star-fill' : 'pi pi-star'"
        text
        rounded
        :severity="detail.favourite ? 'warn' : 'secondary'"
        :aria-label="detail.favourite ? 'Favorit entfernen' : 'Als Favorit markieren'"
        :aria-pressed="detail.favourite"
        @click="toggleFavourite"
      />
    </template>

    <template #toolbar>
      <ListToolbar :model="toolbar" />
      <div v-if="filterOpen" class="cd-filter">
        <Button
          v-for="t in typesPresent"
          :key="t"
          :label="ENTITY_LABELS[t].plural"
          :icon="ENTITY_LABELS[t].icon"
          size="small"
          :outlined="typeFilter !== t"
          :aria-pressed="typeFilter === t"
          @click="setType(typeFilter === t ? null : t)"
        />
      </div>
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" closable @retry="load" @close="error = ''" />
      <Message v-if="detail && detail.hidden_count > 0" severity="secondary" :closable="false">
        {{ detail.hidden_count }} {{ detail.hidden_count === 1 ? 'Eintrag ist' : 'Einträge sind' }}
        für dich nicht sichtbar.
      </Message>
    </template>

    <PageSkeleton v-if="loading && !detail" />
    <EmptyState
      v-else-if="detail && visible.length === 0"
      icon="pi pi-folder-open"
      :title="filtered ? 'Nichts Passendes in dieser Sammelmappe' : 'Diese Sammelmappe ist leer'"
      :message="filtered ? undefined : 'Lege Dinge aus jeder Liste oder Detailseite hinein.'"
      :filtered="filtered"
      @clear-filters="setType(null); search.clear()"
    />

    <section v-for="g in groups" :key="g.type" class="cd-group" :aria-label="g.label.plural">
      <header class="cd-group-header">
        <h2 class="cd-group-title">
          <i :class="g.label.icon" aria-hidden="true" />
          {{ g.label.plural }} <span class="cd-group-count">{{ g.members.length }}</span>
        </h2>
        <Button
          v-if="g.list"
          label="Als Liste öffnen"
          icon="pi pi-external-link"
          size="small"
          text
          @click="router.push(g.list)"
        />
      </header>
      <ul class="cd-rows">
        <li v-for="m in g.members" :key="`${m.entity_type}:${m.entity_id}`" class="cd-row">
          <button
            type="button"
            class="cd-row-body"
            :disabled="!memberRoute(m.entity_type, m.entity_id)"
            :aria-label="`Öffnen: ${m.title}`"
            @click="openMember(m)"
          >
            <span class="cd-row-title">{{ m.title }}</span>
            <span class="cd-row-meta">
              <span v-if="m.subtitle">{{ m.subtitle }}</span>
              <span v-if="m.date">{{ formatDate(m.date) }}</span>
              <span v-if="formatAmount(m)" class="cd-row-amount">{{ formatAmount(m) }}</span>
            </span>
          </button>
          <Button
            icon="pi pi-times"
            text
            rounded
            size="small"
            severity="secondary"
            :aria-label="`Aus der Sammelmappe nehmen: ${m.title}`"
            @click="remove(m)"
          />
        </li>
      </ul>
    </section>
  </PageLayout>
</template>

<style scoped>
.cd-filter {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3) var(--page-gutter);
  border-top: 1px solid var(--p-content-border-color);
}
.cd-group {
  margin-bottom: var(--space-5);
}
.cd-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.cd-group-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-lg);
  font-weight: 600;
}
.cd-group-count {
  color: var(--p-text-muted-color);
  font-weight: 400;
}
.cd-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.cd-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
}
.cd-row-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2);
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--p-text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cd-row-body:disabled {
  cursor: default;
}
.cd-row-body:hover:not(:disabled) {
  background: var(--p-content-hover-background);
}
.cd-row-body:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.cd-row-title {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.cd-row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.cd-row-amount {
  font-variant-numeric: tabular-nums;
}
</style>
