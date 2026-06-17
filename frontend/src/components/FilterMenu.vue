<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import ToggleSwitch from 'primevue/toggleswitch'
import Slider from 'primevue/slider'
import InputNumber from 'primevue/inputnumber'
import AutoComplete from 'primevue/autocomplete'
import DateRangePresets from './DateRangePresets.vue'
import { toLocalIsoDate, parseLocalDate } from '../utils/dateFormat'
import type { PhotoFilter, HiddenMode, MembershipMode, MediaType, Album, Person } from '../api/photos'
import { useReferenceData } from '../composables/useReferenceData'

/**
 * Modal filter editor. Takes the `draft` ref, edits it in place, and emits
 * `apply` / `reset` / `close` events. Only the buttons apply / reset touch
 * the "applied" state outside this component.
 *
 * `available` restricts which criteria are shown for views that don't need
 * them all (e.g. Albums view doesn't need the "in group" filter).
 */

const props = withDefaults(defineProps<{
  visible: boolean
  draft: PhotoFilter
  /** Criteria to show. Default: all photo-level criteria. */
  available?: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange'>
}>(), {
  available: () => [
    'hiddenMode', 'showAiHidden', 'favorite', 'albumHighlight', 'groupHighlight', 'inGroup',
    'othersFavorited', 'othersHidden', 'notInAnyAlbum',
    'qualityRange', 'albumIds', 'personIds', 'mediaTypes',
    'hasGps', 'hasFaces', 'hasAssignedPerson',
    'dateRange', 'importedDaysAgo', 'sizeRange',
  ],
})

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'update:draft', v: PhotoFilter): void
  (e: 'apply'): void
  (e: 'reset'): void
}>()

function has(key: string): boolean {
  return (props.available as string[]).includes(key)
}

function isPersonDetailPhotoFilter(): boolean {
  const available = props.available as string[]
  return available.includes('sizeRange')
    && available.includes('hasGps')
    && available.includes('mediaTypes')
    && available.includes('favorite')
    && available.includes('qualityRange')
    && available.includes('dateRange')
    && !available.includes('albumIds')
    && !available.includes('personIds')
    && !available.includes('ownerIds')
    && !available.includes('importedDaysAgo')
}

const local = ref<PhotoFilter>({ ...props.draft })

// Mirror local → parent on every edit. The draft → local sync happens only
// when the dialog opens (see the visible watcher below). Watching the draft
// continuously would form a feedback loop with the local/range watchers:
// local edit → emit → parent draft → watch draft → reset qualityRange/dateFrom
// → range watchers write back to local → emit → … until Vue's scheduler
// gives up and the UI freezes.
watch(local, (v) => emit('update:draft', v), { deep: true })

// Sync all derived editor state (ranges, dates, selections) from the draft
// once, at the moment the dialog transitions from hidden → visible.
watch(() => props.visible, (v) => {
  if (!v) return
  local.value = { ...props.draft }
  qualityRange.value = [props.draft.qualityMin ?? 0, props.draft.qualityMax ?? 100]
  dateFrom.value = props.draft.dateFrom ? parseLocalDate(props.draft.dateFrom) : null
  dateTo.value = props.draft.dateTo ? parseLocalDate(props.draft.dateTo) : null
  selectedAlbums.value = props.draft.albumIds?.length && albums.value.length
    ? albums.value.filter(a => props.draft.albumIds!.includes(a.id))
    : []
  selectedPersons.value = props.draft.personIds?.length && persons.value.length
    ? persons.value.filter(p => props.draft.personIds!.includes(p.id))
    : []
  selectedOwners.value = props.draft.ownerIds?.length && users.value.length
    ? users.value
        .filter(u => props.draft.ownerIds!.includes(u.id))
        .map(u => ({ id: u.id, name: u.name }))
    : []
})

const hiddenOptions: Array<{ label: string; value: HiddenMode }> = [
  { label: 'Ohne', value: 'exclude' },
  { label: 'Mit', value: 'include' },
  { label: 'Nur', value: 'only' },
]
const membershipOptions: Array<{ label: string; value: MembershipMode }> = [
  { label: 'Einschließen', value: 'include' },
  { label: 'Ausschließen', value: 'exclude' },
]
const mediaTypeOptions: Array<{ label: string; value: MediaType }> = [
  { label: 'Foto', value: 'photo' },
  { label: 'Video', value: 'video' },
  { label: 'RAW', value: 'raw' },
]
const triOptions: Array<{ label: string; value: 'any' | 'yes' | 'no' }> = [
  { label: 'Egal', value: 'any' },
  { label: 'Ja', value: 'yes' },
  { label: 'Nein', value: 'no' },
]

// --- Range helpers ----------------------------------------------------------
const qualityRange = ref<[number, number]>([
  props.draft.qualityMin ?? 0,
  props.draft.qualityMax ?? 100,
])
watch(qualityRange, ([min, max]) => {
  local.value = {
    ...local.value,
    qualityMin: min > 0 ? min : undefined,
    qualityMax: max < 100 ? max : undefined,
  }
})

const dateFrom = ref<Date | null>(props.draft.dateFrom ? parseLocalDate(props.draft.dateFrom) : null)
const dateTo = ref<Date | null>(props.draft.dateTo ? parseLocalDate(props.draft.dateTo) : null)
watch([dateFrom, dateTo], ([from, to]) => {
  local.value = {
    ...local.value,
    dateFrom: from ? toLocalIsoDate(from) : undefined,
    dateTo: to ? toLocalIsoDate(to) : undefined,
  }
})

// --- Tri-state helpers ------------------------------------------------------
function triValue(v: boolean | undefined): 'any' | 'yes' | 'no' {
  if (v === true) return 'yes'
  if (v === false) return 'no'
  return 'any'
}
function setTri(key: 'hasGps' | 'hasFaces' | 'hasAssignedPerson', v: 'any' | 'yes' | 'no') {
  const next = { ...local.value }
  if (v === 'any') delete next[key]
  else next[key] = v === 'yes'
  local.value = next
}

// --- Album / Person autocomplete -------------------------------------------
// Listen kommen aus dem app-weiten Composable, sodass parallele Aufrufer
// (GalleryView, FilterChips, PhotoDetailSidebar) sich denselben Request teilen.
const { albums, persons, users, fetchAlbums, fetchPersons, fetchUsers } = useReferenceData()
const selectedAlbums = ref<Album[]>([])
const selectedPersons = ref<Person[]>([])
const selectedOwners = ref<{ id: number; name: string }[]>([])
const albumSuggestions = ref<Album[]>([])
const personSuggestions = ref<Person[]>([])
const ownerSuggestions = ref<{ id: number; name: string }[]>([])

async function loadAlbumsIfNeeded() {
  try {
    await fetchAlbums()
    if (props.draft.albumIds?.length) {
      selectedAlbums.value = albums.value.filter(a => props.draft.albumIds!.includes(a.id))
    }
  } catch { /* ignore */ }
}
async function loadPersonsIfNeeded() {
  try {
    await fetchPersons()
    if (props.draft.personIds?.length) {
      selectedPersons.value = persons.value.filter(p => props.draft.personIds!.includes(p.id))
    }
  } catch { /* ignore */ }
}
async function loadUsersIfNeeded() {
  try {
    await fetchUsers()
    if (props.draft.ownerIds?.length) {
      selectedOwners.value = users.value
        .filter(u => props.draft.ownerIds!.includes(u.id))
        .map(u => ({ id: u.id, name: u.name }))
    }
  } catch { /* ignore */ }
}

onMounted(() => {
  if (has('albumIds')) loadAlbumsIfNeeded()
  if (has('personIds')) loadPersonsIfNeeded()
  if (has('ownerIds')) loadUsersIfNeeded()
})

function searchAlbums(event: { query: string }) {
  const q = event.query.toLowerCase()
  albumSuggestions.value = albums.value
    .filter(a => !selectedAlbums.value.some(s => s.id === a.id))
    .filter(a => !q || a.name.toLowerCase().includes(q))
    .slice(0, 20)
}
function searchPersons(event: { query: string }) {
  const q = event.query.toLowerCase()
  personSuggestions.value = persons.value
    .filter(p => !selectedPersons.value.some(s => s.id === p.id))
    .filter(p => p.name && (!q || p.name.toLowerCase().includes(q)))
    .slice(0, 20)
}
function searchOwners(event: { query: string }) {
  const q = event.query.toLowerCase()
  ownerSuggestions.value = users.value
    .filter(u => !selectedOwners.value.some(s => s.id === u.id))
    .filter(u => !q || u.name.toLowerCase().includes(q))
    .map(u => ({ id: u.id, name: u.name }))
    .slice(0, 20)
}

watch(selectedAlbums, (list) => {
  local.value = {
    ...local.value,
    albumIds: list.length ? list.map(a => a.id) : undefined,
    albumMode: list.length ? (local.value.albumMode ?? 'include') : undefined,
  }
})
watch(selectedPersons, (list) => {
  local.value = {
    ...local.value,
    personIds: list.length ? list.map(p => p.id) : undefined,
    personMode: list.length ? (local.value.personMode ?? 'include') : undefined,
  }
})
watch(selectedOwners, (list) => {
  local.value = {
    ...local.value,
    ownerIds: list.length ? list.map(u => u.id) : undefined,
  }
})

function handleApply() {
  emit('apply')
  emit('update:visible', false)
}
function handleReset() {
  local.value = {}
  qualityRange.value = [0, 100]
  dateFrom.value = null
  dateTo.value = null
  selectedAlbums.value = []
  selectedPersons.value = []
  selectedOwners.value = []
  emit('reset')
}

function close() {
  emit('update:visible', false)
}
</script>

<template>
  <Dialog
    :visible="props.visible"
    @update:visible="(v: boolean) => emit('update:visible', v)"
    header="Filter"
    modal
    :style="{ width: 'min(100%, 720px)' }"
  >
    <div class="filter-menu">
      <!-- Tri-state: Hidden -->
      <div v-if="has('hiddenMode')" class="filter-row">
        <label class="filter-label">Ausgeblendet</label>
        <SelectButton
          :model-value="local.hiddenMode ?? 'exclude'"
          :options="hiddenOptions" option-label="label" option-value="value"
          :allow-empty="false"
          @update:model-value="(v: HiddenMode) => local = { ...local, hiddenMode: v === 'exclude' ? undefined : v }"
        />
      </div>

      <!-- AI-Auto-Pick (Track I): when hochkonfidente Picks gemacht wurden
           verstecken wir die Nicht-Picks per Default. Mit diesem Schalter
           werden sie wieder eingeblendet, ohne den User-Hide-Filter zu
           berühren. -->
      <div v-if="has('showAiHidden')" class="filter-switch">
        <ToggleSwitch v-model="local.showAiHidden" />
        <span>KI-ausgeblendete anzeigen</span>
      </div>

      <!-- Boolean switches -->
      <div class="filter-grid">
        <div v-if="has('favorite')" class="filter-switch">
          <ToggleSwitch v-model="local.favorite" />
          <span>Nur Favoriten</span>
        </div>
        <div v-if="has('albumHighlight')" class="filter-switch">
          <ToggleSwitch v-model="local.albumHighlight" />
          <span>Album-Highlight</span>
        </div>
        <div v-if="has('groupHighlight')" class="filter-switch">
          <ToggleSwitch v-model="local.groupHighlight" />
          <span>Gruppen-Highlight</span>
        </div>
        <div v-if="has('inGroup')" class="filter-switch">
          <ToggleSwitch v-model="local.inGroup" />
          <span>In einer Ähnlichkeitsgruppe</span>
        </div>
        <div v-if="has('othersFavorited')" class="filter-switch">
          <ToggleSwitch v-model="local.othersFavorited" />
          <span>Von anderen favorisiert</span>
        </div>
        <div v-if="has('othersHidden')" class="filter-switch">
          <ToggleSwitch v-model="local.othersHidden" />
          <span>Von anderen ausgeblendet</span>
        </div>
        <div v-if="has('notInAnyAlbum')" class="filter-switch">
          <ToggleSwitch v-model="local.notInAnyAlbum" />
          <span>Nicht in einem Album</span>
        </div>
      </div>

      <!-- Quality range -->
      <div v-if="has('qualityRange')" class="filter-row">
        <label class="filter-label">
          Qualität: {{ qualityRange[0] }}% – {{ qualityRange[1] }}%
        </label>
        <Slider v-model="qualityRange" range :min="0" :max="100" class="filter-slider" />
      </div>

      <!-- Albums multi-select -->
      <div v-if="has('albumIds')" class="filter-row">
        <label class="filter-label">Alben</label>
        <AutoComplete
          v-model="selectedAlbums"
          :suggestions="albumSuggestions"
          multiple
          option-label="name"
          :input-style="{ width: '100%' }"
          placeholder="Album suchen …"
          @complete="searchAlbums"
          @focus="loadAlbumsIfNeeded"
        />
        <SelectButton
          v-if="selectedAlbums.length"
          class="mode-toggle"
          :model-value="local.albumMode ?? 'include'"
          :options="membershipOptions" option-label="label" option-value="value"
          :allow-empty="false"
          @update:model-value="(v: MembershipMode) => local = { ...local, albumMode: v }"
        />
      </div>

      <!-- Persons multi-select -->
      <div v-if="has('personIds')" class="filter-row">
        <label class="filter-label">Personen</label>
        <AutoComplete
          v-model="selectedPersons"
          :suggestions="personSuggestions"
          multiple
          option-label="name"
          :input-style="{ width: '100%' }"
          placeholder="Person suchen …"
          @complete="searchPersons"
          @focus="loadPersonsIfNeeded"
        />
        <SelectButton
          v-if="selectedPersons.length"
          class="mode-toggle"
          :model-value="local.personMode ?? 'include'"
          :options="membershipOptions" option-label="label" option-value="value"
          :allow-empty="false"
          @update:model-value="(v: MembershipMode) => local = { ...local, personMode: v }"
        />
      </div>

      <!-- Owners multi-select -->
      <div v-if="has('ownerIds')" class="filter-row">
        <label class="filter-label">Hochgeladen von</label>
        <AutoComplete
          v-model="selectedOwners"
          :suggestions="ownerSuggestions"
          multiple
          option-label="name"
          :input-style="{ width: '100%' }"
          placeholder="Benutzer suchen …"
          @complete="searchOwners"
          @focus="loadUsersIfNeeded"
        />
      </div>

      <!-- Media types -->
      <div v-if="has('mediaTypes')" class="filter-row">
        <label class="filter-label">Medientyp</label>
        <SelectButton
          :model-value="local.mediaTypes ?? []"
          :options="mediaTypeOptions" option-label="label" option-value="value"
          multiple
          @update:model-value="(v: MediaType[]) => local = { ...local, mediaTypes: v.length ? v : undefined }"
        />
      </div>

      <!-- GPS / Faces / Person tri-states -->
      <div v-if="has('hasGps')" class="filter-row">
        <label class="filter-label">GPS-Daten</label>
        <SelectButton
          :model-value="triValue(local.hasGps)"
          :options="triOptions" option-label="label" option-value="value"
          :allow-empty="false"
          @update:model-value="(v: 'any' | 'yes' | 'no') => setTri('hasGps', v)"
        />
      </div>
      <div v-if="has('hasFaces')" class="filter-row">
        <label class="filter-label">Gesichter erkannt</label>
        <SelectButton
          :model-value="triValue(local.hasFaces)"
          :options="triOptions" option-label="label" option-value="value"
          :allow-empty="false"
          @update:model-value="(v: 'any' | 'yes' | 'no') => setTri('hasFaces', v)"
        />
      </div>
      <div v-if="has('hasAssignedPerson')" class="filter-row">
        <label class="filter-label">Person zugeordnet</label>
        <SelectButton
          :model-value="triValue(local.hasAssignedPerson)"
          :options="triOptions" option-label="label" option-value="value"
          :allow-empty="false"
          @update:model-value="(v: 'any' | 'yes' | 'no') => setTri('hasAssignedPerson', v)"
        />
      </div>

      <!-- Date range -->
      <div v-if="has('dateRange')" class="filter-row">
        <label class="filter-label">Aufnahmedatum</label>
        <DateRangePresets v-model:from="dateFrom" v-model:to="dateTo" />
      </div>

      <!-- Imported days ago -->
      <div v-if="has('importedDaysAgo')" class="filter-row">
        <label class="filter-label">Kürzlich importiert (Tage)</label>
        <InputNumber
          :model-value="local.importedDaysAgo"
          :min="0"
          :max="3650"
          show-buttons
          @update:model-value="(v: number | null) => local = { ...local, importedDaysAgo: v && v > 0 ? v : undefined }"
        />
      </div>

      <!-- Size range -->
      <div v-if="has('sizeRange') && !isPersonDetailPhotoFilter()" class="filter-row">
        <label class="filter-label">Dateigröße (MB)</label>
        <div class="filter-daterange">
          <InputNumber
            :model-value="local.sizeMin !== undefined ? Math.round(local.sizeMin / (1024 * 1024)) : null"
            :min="0" placeholder="Min"
            @update:model-value="(v: number | null) => local = { ...local, sizeMin: v && v > 0 ? v * 1024 * 1024 : undefined }"
          />
          <InputNumber
            :model-value="local.sizeMax !== undefined ? Math.round(local.sizeMax / (1024 * 1024)) : null"
            :min="0" placeholder="Max"
            @update:model-value="(v: number | null) => local = { ...local, sizeMax: v && v > 0 ? v * 1024 * 1024 : undefined }"
          />
        </div>
      </div>
    </div>

    <template #footer>
      <Button label="Zurücksetzen" text severity="secondary" @click="handleReset" />
      <Button label="Abbrechen" text @click="close" />
      <Button label="Anwenden" icon="pi pi-check" @click="handleApply" />
    </template>
  </Dialog>
</template>

<style scoped>
.filter-menu { display: flex; flex-direction: column; gap: 1.25rem; }
.filter-row { display: flex; flex-direction: column; gap: 0.5rem; }
.filter-label { font-weight: 500; font-size: 0.9rem; color: var(--text-color-secondary, #555); }
.filter-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 0.75rem; }
.filter-switch { display: flex; align-items: center; gap: 0.6rem; }
.filter-slider { margin: 0.5rem 0.25rem; }
.filter-daterange { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.filter-daterange > * { flex: 1 1 140px; }
.mode-toggle { margin-top: 0.4rem; align-self: flex-start; }
</style>
