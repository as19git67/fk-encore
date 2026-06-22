<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import SelectButton from 'primevue/selectbutton'
import ToggleSwitch from 'primevue/toggleswitch'
import Slider from 'primevue/slider'
import InputNumber from 'primevue/inputnumber'
import AutoComplete from 'primevue/autocomplete'
import DateRangePresets from './DateRangePresets.vue'
import { toLocalIsoDate, parseLocalDate } from '../utils/dateFormat'
import {
  autocompletePhotoLocations,
  type PhotoFilter,
  type HiddenMode,
  type MembershipMode,
  type MediaType,
  type Album,
  type Person,
  type LocationSuggestion,
} from '../api/photos'
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
  /** GPS point of the photo currently selected by the surrounding view. */
  referenceLocation?: { latitude: number; longitude: number; label?: string }
  /** Criteria to show. Default: all photo-level criteria. */
  available?: Array<keyof PhotoFilter | 'dateRange' | 'qualityRange' | 'sizeRange' | 'nearLocation'>
}>(), {
  available: () => [
    'hiddenMode', 'showAiHidden', 'favorite', 'albumHighlight', 'groupHighlight', 'inGroup',
    'othersFavorited', 'othersHidden', 'notInAnyAlbum',
    'qualityRange', 'albumIds', 'personIds', 'mediaTypes',
    'hasGps', 'hasFaces', 'hasAssignedPerson',
    'dateRange', 'importedDaysAgo', 'nearLocation',
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
const locationError = ref('')
const locationPlace = ref<LocationSuggestion | null>(null)
const locationSuggestions = ref<LocationSuggestion[]>([])
let locationSearchSequence = 0
const mapOpen = ref(false)
const locationMapContainer = ref<HTMLElement | null>(null)
let locationMap: L.Map | null = null
let locationMarker: L.Marker | null = null
const LOCATION_PICKER_ZOOM = 13

function locationPickerIcon(): L.DivIcon {
  return L.divIcon({
    className: 'location-picker-pin-icon',
    iconSize: [24, 32],
    iconAnchor: [12, 32],
    html: '<span class="location-picker-pin" />',
  })
}

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
  locationPlace.value = props.draft.nearLat !== undefined && props.draft.nearLon !== undefined
    ? { label: 'Ausgewählter Standort', latitude: props.draft.nearLat, longitude: props.draft.nearLon }
    : null
  locationError.value = ''
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

function useCurrentLocation() {
  locationError.value = ''
  if (!navigator.geolocation) {
    locationError.value = 'Dein Browser unterstützt keine Standortabfrage.'
    return
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      local.value = {
        ...local.value,
        nearLat: coords.latitude,
        nearLon: coords.longitude,
        nearRadiusKm: local.value.nearRadiusKm ?? 10,
      }
      locationPlace.value = {
        label: 'Aktueller Standort',
        latitude: coords.latitude,
        longitude: coords.longitude,
      }
      setLocationMarker(coords.latitude, coords.longitude)
    },
    () => { locationError.value = 'Standort konnte nicht abgerufen werden. Bitte erlaube den Zugriff.' },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
  )
}

function useReferenceLocation() {
  const location = props.referenceLocation
  if (!location) return
  local.value = {
    ...local.value,
    nearLat: location.latitude,
    nearLon: location.longitude,
    nearRadiusKm: local.value.nearRadiusKm ?? 10,
  }
  locationPlace.value = {
    label: location.label ? `Ort von ${location.label}` : 'Ort des ausgewählten Fotos',
    latitude: location.latitude,
    longitude: location.longitude,
  }
  setLocationMarker(location.latitude, location.longitude)
  locationError.value = ''
}

async function searchLocations(event: { query: string }) {
  const query = event.query.trim()
  const sequence = ++locationSearchSequence
  if (query.length < 3) {
    locationSuggestions.value = []
    return
  }
  // PrimeVue invokes this for every keypress; wait briefly and only search
  // for the most recent input before hitting the rate-limited backend.
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (sequence !== locationSearchSequence) return
  try {
    const { locations } = await autocompletePhotoLocations(query)
    if (sequence === locationSearchSequence) locationSuggestions.value = locations
  } catch {
    if (sequence === locationSearchSequence) locationSuggestions.value = []
  }
}

function selectLocation(event: { value: LocationSuggestion }) {
  const place = event.value
  locationPlace.value = place
  local.value = {
    ...local.value,
    nearLat: place.latitude,
    nearLon: place.longitude,
    nearRadiusKm: local.value.nearRadiusKm ?? 10,
  }
  locationError.value = ''
  setLocationMarker(place.latitude, place.longitude)
}

function clearNearLocation() {
  const next = { ...local.value }
  delete next.nearLat
  delete next.nearLon
  delete next.nearRadiusKm
  local.value = next
  locationPlace.value = null
  locationSuggestions.value = []
  if (locationMarker) {
    locationMap?.removeLayer(locationMarker)
    locationMarker = null
  }
  locationError.value = ''
}

async function toggleLocationMap() {
  mapOpen.value = !mapOpen.value
  if (!mapOpen.value) return
  await nextTick()
  // The map is kept mounted while hidden. Leaflet otherwise retains a map
  // bound to the removed v-if node and reopens as an empty white rectangle.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (!locationMapContainer.value) return
  const lat = local.value.nearLat ?? 48.1372
  const lon = local.value.nearLon ?? 11.5756
  const zoom = local.value.nearLat === undefined ? 5 : LOCATION_PICKER_ZOOM
  if (!locationMap) {
    locationMap = L.map(locationMapContainer.value).setView([lat, lon], zoom)
    L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap-Mitwirkende',
    }).addTo(locationMap)
    locationMap.on('click', (event: L.LeafletMouseEvent) => setLocationFromMap(event.latlng.lat, event.latlng.lng))
  }
  locationMap.invalidateSize(true)
  // Always restore the selected point and its useful inspection zoom when
  // reopening; a former manual pan/zoom must not hide the active pin.
  locationMap.setView([lat, lon], zoom)
  if (local.value.nearLat !== undefined && local.value.nearLon !== undefined) {
    setLocationMarker(lat, lon)
  }
}

function setLocationMarker(latitude: number, longitude: number) {
  if (!locationMap) return
  if (locationMarker) locationMarker.setLatLng([latitude, longitude])
  else locationMarker = L.marker([latitude, longitude], { icon: locationPickerIcon() }).addTo(locationMap)
}

function setLocationFromMap(latitude: number, longitude: number) {
  local.value = { ...local.value, nearLat: latitude, nearLon: longitude, nearRadiusKm: local.value.nearRadiusKm ?? 10 }
  locationPlace.value = { label: 'Punkt auf der Karte', latitude, longitude }
  setLocationMarker(latitude, longitude)
  locationMap?.setView([latitude, longitude], LOCATION_PICKER_ZOOM)
  locationError.value = ''
}

onUnmounted(() => {
  locationMap?.remove()
  locationMap = null
  locationMarker = null
})

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
      <div v-if="has('hasGps') && !isPersonDetailPhotoFilter()" class="filter-row">
        <label class="filter-label">GPS-Daten</label>
        <SelectButton
          :model-value="triValue(local.hasGps)"
          :options="triOptions" option-label="label" option-value="value"
          :allow-empty="false"
          @update:model-value="(v: 'any' | 'yes' | 'no') => setTri('hasGps', v)"
        />
      </div>

      <!-- Current location / proximity -->
      <div v-if="has('nearLocation')" class="filter-row">
        <label class="filter-label">In der Nähe meines Standorts</label>
        <AutoComplete
          v-model="locationPlace"
          :suggestions="locationSuggestions"
          option-label="label"
          placeholder="Ort oder Adresse suchen …"
          :min-length="3"
          force-selection
          dropdown
          @complete="searchLocations"
          @item-select="selectLocation"
        />
        <div class="near-location-controls">
          <Button label="Punkt auf Karte setzen" icon="pi pi-map" outlined @click="toggleLocationMap" />
          <Button
            v-if="props.referenceLocation"
            label="Ort des ausgewählten Fotos verwenden" icon="pi pi-image" outlined
            @click="useReferenceLocation"
          />
          <Button label="Aktuellen Standort verwenden" icon="pi pi-map-marker" outlined @click="useCurrentLocation" />
          <Button
            v-if="local.nearLat !== undefined && local.nearLon !== undefined"
            label="Entfernen" icon="pi pi-times" text severity="secondary"
            @click="clearNearLocation"
          />
        </div>
        <div v-show="mapOpen" ref="locationMapContainer" class="location-picker-map" />
        <template v-if="local.nearLat !== undefined && local.nearLon !== undefined">
          <div class="filter-daterange">
            <InputNumber
              :model-value="local.nearRadiusKm ?? 10"
              :min="1" :max="20000" :min-fraction-digits="0" :max-fraction-digits="0" :step="1"
              suffix=" km" show-buttons
              @update:model-value="(v: number | null) => local = { ...local, nearRadiusKm: v && v > 0 ? Math.round(v) : 10 }"
            />
          </div>
          <small class="filter-hint">Fotos im Umkreis dieses Radius werden angezeigt.</small>
        </template>
        <small class="filter-hint">Ortssuche: © OpenStreetMap-Mitwirkende</small>
        <small v-if="locationError" class="location-error">{{ locationError }}</small>
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
.near-location-controls { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.filter-hint { color: var(--text-color-secondary, #555); }
.location-error { color: var(--red-500, #d32f2f); }
.location-picker-map { height: 260px; border: 1px solid var(--p-content-border-color, #dee2e6); border-radius: 6px; }
:deep(.location-picker-pin-icon) { background: transparent; border: 0; }
:deep(.location-picker-pin) { display: block; width: 20px; height: 20px; background: var(--p-primary-color, #3b82f6); border: 3px solid white; border-radius: 50% 50% 50% 0; box-shadow: 0 1px 4px rgb(0 0 0 / 35%); transform: rotate(-45deg); }
</style>
