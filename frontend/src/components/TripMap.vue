<script lang="ts" setup>
import { ref, computed, toRef, onMounted, onUnmounted, watch, nextTick } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Photo } from '../api/photos'
import { getPhotoUrl } from '../api/photos'
import { usePhotoStops, type Stop } from '../composables/usePhotoStops'
import TripMapNoGpsPanel from './TripMapNoGpsPanel.vue'

const props = defineProps<{
  photos: Photo[]
  albumName?: string
  albumDescription?: string
}>()

const emit = defineEmits<{
  'open-fullscreen': [stopPhotos: Photo[], startIndex: number]
}>()

const { stops, photosWithoutGps, dayPaths, dayTransitions, dayColorMap, uniqueDays, bounds } =
  usePhotoStops(toRef(props, 'photos'))

const mapContainer = ref<HTMLElement | null>(null)
const timelineContainer = ref<HTMLElement | null>(null)
let map: L.Map | null = null
const markers: L.Marker[] = []
const polylines: L.Polyline[] = []

const selectedStopId = ref<number | null>(null)

// Track which days are currently expanded in the timeline
const expandedDays = ref<Set<string>>(new Set())

// Group stops by day while preserving chronological order
const stopsByDay = computed<Map<string, Stop[]>>(() => {
  const map = new Map<string, Stop[]>()
  for (const stop of stops.value) {
    if (!map.has(stop.day)) map.set(stop.day, [])
    map.get(stop.day)!.push(stop)
  }
  return map
})

// Flat list of stop IDs currently visible in the timeline, taking the
// expanded/collapsed state of each day into account. For a collapsed
// day only the first (cover) stop is visible.
const visibleStopIds = computed<number[]>(() => {
  const ids: number[] = []
  for (const day of uniqueDays.value) {
    const dayStops = stopsByDay.value.get(day) ?? []
    if (dayStops.length === 0) continue
    if (expandedDays.value.has(day)) {
      for (const s of dayStops) ids.push(s.id)
    } else {
      ids.push(dayStops[0]!.id)
    }
  }
  return ids
})

function formatDayLabel(day: string): string {
  // day = YYYY-MM-DD → DD. Mon
  const d = new Date(day + 'T00:00:00')
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
}

function toggleDay(day: string) {
  if (expandedDays.value.has(day)) {
    expandedDays.value.delete(day)
  } else {
    expandedDays.value.add(day)
  }
  // Trigger reactivity on a Set in a ref
  expandedDays.value = new Set(expandedDays.value)
}

function handleDayCardClick(day: string) {
  const dayStops = stopsByDay.value.get(day) ?? []
  const first = dayStops[0]
  if (!first) return
  if (dayStops.length > 1) {
    toggleDay(day)
  }
  selectStop(first.id)
}

// ── Map initialization ───────────────────────────────────────────────────────

function createPinIcon(stop: Stop, isSelected: boolean): L.DivIcon {
  const url = getPhotoUrl(stop.coverPhoto.filename, 96)
  const count = stop.photos.length
  const badge = count > 1 ? `<span class="trip-pin-badge">${count}</span>` : ''
  const selectedClass = isSelected ? ' trip-pin-selected' : ''

  return L.divIcon({
    className: 'trip-pin-icon',
    iconSize: [48, 48],
    iconAnchor: [24, 48],
    popupAnchor: [0, -50],
    html: `
      <div class="trip-pin-container${selectedClass}">
        <div class="trip-pin-thumbnail">
          <img src="${url}" alt="" />
        </div>
        ${badge}
        <div class="trip-pin-pointer"></div>
      </div>
    `,
  })
}

function createPopupContent(stop: Stop): string {
  const url = getPhotoUrl(stop.coverPhoto.filename, 400)
  const label = stop.locationLabel || `${stop.photos.length} Foto${stop.photos.length > 1 ? 's' : ''}`
  const dateStr = new Date(stop.coverPhoto.taken_at || stop.coverPhoto.created_at)
    .toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return `
    <div class="trip-popup">
      <img src="${url}" alt="" class="trip-popup-img" />
      <div class="trip-popup-info">
        <div class="trip-popup-label">${label}</div>
        <div class="trip-popup-date">${dateStr}</div>
        ${stop.photos.length > 1 ? `<div class="trip-popup-count">${stop.photos.length} Fotos an diesem Stopp</div>` : ''}
      </div>
    </div>
  `
}

function updateMarkerIcons() {
  for (let i = 0; i < stops.value.length; i++) {
    const stop = stops.value[i]!
    const marker = markers[i]
    if (marker) {
      marker.setIcon(createPinIcon(stop, stop.id === selectedStopId.value))
    }
  }
}

function selectStop(stopId: number, panMap = true) {
  selectedStopId.value = stopId
  updateMarkerIcons()

  const stop = stops.value.find(s => s.id === stopId)
  if (!stop || !map) return

  // Auto-expand the day of the selected stop if it's not the cover/first stop
  // (e.g. when the stop is selected via a map marker and its day is collapsed)
  const dayStops = stopsByDay.value.get(stop.day) ?? []
  if (dayStops.length > 1 && dayStops[0]!.id !== stopId && !expandedDays.value.has(stop.day)) {
    expandedDays.value = new Set(expandedDays.value).add(stop.day)
  }

  if (panMap) {
    map.flyTo([stop.lat, stop.lng], 15, { duration: 0.5 })
  }

  // Scroll timeline to selected stop (wait for DOM to update if day just expanded)
  nextTick(() => scrollTimelineToStop(stopId))
}

function scrollTimelineToStop(stopId: number) {
  const container = timelineContainer.value
  if (!container) return
  let el = container.querySelector(`[data-stop-id="${stopId}"]`) as HTMLElement | null
  // If the stop isn't directly rendered (collapsed day), scroll to the day group
  if (!el) {
    const stop = stops.value.find(s => s.id === stopId)
    if (stop) el = container.querySelector(`[data-day="${stop.day}"]`) as HTMLElement | null
  }
  if (!el) return
  const containerRect = container.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const scrollLeft = el.offsetLeft - containerRect.width / 2 + elRect.width / 2
  container.scrollTo({ left: scrollLeft, behavior: 'smooth' })
}

function initMap() {
  if (!mapContainer.value || map) return

  map = L.map(mapContainer.value, {
    zoomControl: true,
    attributionControl: true,
  })

  L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map)

  renderContent()
}

function clearContent() {
  markers.forEach((m) => m.remove())
  markers.length = 0
  polylines.forEach((p) => p.remove())
  polylines.length = 0
}

function renderContent() {
  if (!map) return
  clearContent()

  // Draw day paths
  for (const path of dayPaths.value) {
    if (path.coordinates.length < 2) continue
    const line = L.polyline(path.coordinates, {
      color: path.color,
      weight: 3,
      opacity: 0.7,
    }).addTo(map)
    polylines.push(line)
  }

  // Draw day transitions (dashed)
  for (const transition of dayTransitions.value) {
    const line = L.polyline(transition.coordinates, {
      color: transition.color,
      weight: 2,
      opacity: 0.5,
      dashArray: '8, 8',
    }).addTo(map)
    polylines.push(line)
  }

  // Draw stop markers
  for (const stop of stops.value) {
    const marker = L.marker([stop.lat, stop.lng], {
      icon: createPinIcon(stop, stop.id === selectedStopId.value),
    }).addTo(map)

    marker.bindPopup(createPopupContent(stop), {
      maxWidth: 280,
      className: 'trip-popup-wrapper',
    })

    marker.on('click', () => {
      selectStop(stop.id, false)
      emit('open-fullscreen', stop.photos, 0)
    })

    markers.push(marker)
  }

  // Fit bounds
  if (bounds.value) {
    map.fitBounds(bounds.value)
  } else {
    map.setView([51.1657, 10.4515], 5) // Default: Germany center
  }
}

// ── Timeline helpers ────────────────────────────────────────────────────────

function getStopLabel(stop: Stop): string {
  if (stop.locationLabel) return stop.locationLabel
  return `Stopp ${stop.id + 1}`
}

function formatStopDate(stop: Stop): string {
  const date = new Date(stop.coverPhoto.taken_at || stop.coverPhoto.created_at)
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
}


// ── Keyboard navigation between stops ───────────────────────────────────────

function navigateToPrevStop() {
  if (selectedStopId.value == null || stops.value.length === 0) return
  const visible = visibleStopIds.value
  const idx = visible.indexOf(selectedStopId.value)
  if (idx > 0) selectStop(visible[idx - 1]!)
}

function navigateToNextStop() {
  if (selectedStopId.value == null || stops.value.length === 0) return
  const curr = stops.value.find(s => s.id === selectedStopId.value)
  if (!curr) return

  const dayStops = stopsByDay.value.get(curr.day) ?? []
  const isCollapsed = !expandedDays.value.has(curr.day)
  const isFirstOfDay = dayStops[0]?.id === curr.id

  // If on a collapsed multi-stop day, expand it and advance to the next
  // sibling within the day (as per issue #71: "expands automatically when
  // on the day and going right").
  if (isCollapsed && isFirstOfDay && dayStops.length > 1) {
    expandedDays.value = new Set(expandedDays.value).add(curr.day)
    nextTick(() => selectStop(dayStops[1]!.id))
    return
  }

  // Otherwise: move forward through the currently visible items
  const visible = visibleStopIds.value
  const idx = visible.indexOf(curr.id)
  if (idx >= 0 && idx < visible.length - 1) selectStop(visible[idx + 1]!)
}

function handleKeydown(e: KeyboardEvent) {
  if (selectedStopId.value == null) return
  if (e.key === 'ArrowLeft') { e.preventDefault(); navigateToPrevStop() }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigateToNextStop() }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  await nextTick()
  initMap()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})

watch(() => props.photos, () => {
  // Reset collapse state when the underlying photo set changes
  expandedDays.value = new Set()
  selectedStopId.value = null
  renderContent()
}, { deep: true })

function handleNoGpsPhotoClick(photo: Photo) {
  emit('open-fullscreen', [photo], 0)
}

// ── External API ─────────────────────────────────────────────────────────────

/** Select the stop that contains the given photo, if any. Used by the parent
 *  view to sync the map selection with the photo the user ended on in the
 *  fullscreen overlay (issue: "Wenn man in der Vollbildansicht über den Stop
 *  hinaus navigiert, sollte sich das in der Kartenansicht wiederspiegeln,
 *  sobald man die Vollbildansicht verläßt"). */
function selectStopByPhotoId(photoId: number): boolean {
  const stop = stops.value.find((s) => s.photos.some((p) => p.id === photoId))
  if (!stop) return false
  if (stop.id !== selectedStopId.value) selectStop(stop.id)
  return true
}

defineExpose({ selectStopByPhotoId })
</script>

<template>
  <div class="trip-map-wrapper">
    <div ref="mapContainer" class="trip-map-container" />

    <!-- Stats overlay -->
    <div class="trip-stats">
      <span>{{ stops.length }} {{ stops.length === 1 ? 'Stopp' : 'Stopps' }}</span>
      <span class="trip-stats-sep">&bull;</span>
      <span>{{ photos.filter(p => p.latitude != null).length }} Fotos</span>
    </div>

    <!-- Horizontal timeline strip -->
    <div v-if="stops.length > 0" class="trip-timeline-wrapper">
      <div v-if="albumName" class="trip-timeline-header">
        <span class="trip-timeline-album-name">{{ albumName }}</span>
        <span v-if="albumDescription" class="trip-timeline-album-desc">— {{ albumDescription }}</span>
      </div>
      <div ref="timelineContainer" class="trip-timeline">
        <template v-for="day in uniqueDays" :key="day">
          <div
            class="trip-timeline-day-group"
            :class="{ 'trip-timeline-day-group--expanded': expandedDays.has(day) }"
            :data-day="day"
          >
            <!-- Day "cover" card (representative of the whole day). In
                 collapsed mode this is the only visible item for the day;
                 clicking it toggles expansion when the day has >1 stop. -->
            <div
              v-if="stopsByDay.get(day) && stopsByDay.get(day)!.length > 0"
              :data-stop-id="stopsByDay.get(day)![0]!.id"
              :class="[
                'trip-timeline-item',
                'trip-timeline-item--day',
                {
                  'trip-timeline-item--selected': stopsByDay.get(day)![0]!.id === selectedStopId,
                  'trip-timeline-item--expandable': stopsByDay.get(day)!.length > 1,
                  'trip-timeline-item--expanded': expandedDays.has(day) && stopsByDay.get(day)!.length > 1,
                },
              ]"
              :title="stopsByDay.get(day)!.length > 1
                ? (expandedDays.has(day) ? 'Tag einklappen' : 'Tag ausklappen')
                : getStopLabel(stopsByDay.get(day)![0]!)"
              @click="handleDayCardClick(day)"
            >
              <div class="trip-timeline-thumb-wrap">
                <!-- Stacked effect hint that the day holds multiple stops -->
                <div
                  v-if="stopsByDay.get(day)!.length > 1 && !expandedDays.has(day)"
                  class="trip-timeline-stack-hint"
                  :style="{ borderColor: dayColorMap.get(day) }"
                />
                <div class="trip-timeline-thumb">
                  <img
                    :src="getPhotoUrl(stopsByDay.get(day)![0]!.coverPhoto.filename, 96)"
                    :alt="getStopLabel(stopsByDay.get(day)![0]!)"
                  />
                </div>
                <!-- Count badge showing number of stops for the day -->
                <span
                  v-if="stopsByDay.get(day)!.length > 1"
                  class="trip-timeline-day-badge"
                  :style="{ background: dayColorMap.get(day) }"
                >{{ stopsByDay.get(day)!.length }}</span>
              </div>
              <div class="trip-timeline-info">
                <span class="trip-timeline-label">{{ formatDayLabel(day) }}</span>
                <span class="trip-timeline-date">
                  {{ stopsByDay.get(day)!.length }}
                  {{ stopsByDay.get(day)!.length === 1 ? 'Stopp' : 'Stopps' }}
                </span>
                <span
                  v-if="stopsByDay.get(day)!.length > 1"
                  class="trip-timeline-chevron"
                  :class="{ 'trip-timeline-chevron--open': expandedDays.has(day) }"
                  aria-hidden="true"
                >›</span>
              </div>
            </div>

            <!-- Expanded siblings of the day (stops 2..N) -->
            <template v-if="expandedDays.has(day) && (stopsByDay.get(day)?.length ?? 0) > 1">
              <div
                v-for="(stop, sIdx) in stopsByDay.get(day)!.slice(1)"
                :key="stop.id"
                :data-stop-id="stop.id"
                :class="[
                  'trip-timeline-item',
                  'trip-timeline-item--sibling',
                  { 'trip-timeline-item--selected': stop.id === selectedStopId },
                ]"
                @click="selectStop(stop.id)"
              >
                <!-- Connector back to the previous stop of the same day -->
                <div
                  class="trip-timeline-connector trip-timeline-connector--sibling"
                  :style="{ background: dayColorMap.get(day) }"
                />
                <div class="trip-timeline-thumb">
                  <img :src="getPhotoUrl(stop.coverPhoto.filename, 96)" :alt="getStopLabel(stop)" />
                </div>
                <div class="trip-timeline-info">
                  <span class="trip-timeline-label">{{ getStopLabel(stop) }}</span>
                  <span class="trip-timeline-date">{{ formatStopDate(stop) }}</span>
                  <span class="trip-timeline-count">
                    {{ stop.photos.length }} {{ stop.photos.length === 1 ? 'Foto' : 'Fotos' }}
                  </span>
                </div>
                <span class="sr-only">Stopp {{ sIdx + 2 }}</span>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>

    <!-- Photos without GPS -->
    <TripMapNoGpsPanel
      v-if="photosWithoutGps.length > 0"
      :photos="photosWithoutGps"
      @photo-click="handleNoGpsPhotoClick"
    />
  </div>
</template>

<style scoped>
.trip-map-wrapper {
  position: relative;
  z-index: 0; /* isolate Leaflet z-indexes so menubar (z-index: 1100) stays on top */
  width: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.trip-map-container {
  width: 100%;
  flex: 1;
  min-height: 250px;
  border-radius: 8px 8px 0 0;
  overflow: hidden;
}

/* Stats */
.trip-stats {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  padding: 6px 12px;
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.85rem;
}

.trip-stats-sep {
  margin: 0 6px;
  opacity: 0.5;
}

/* ── Timeline strip ─────────────────────────────────────────────────────── */
.trip-timeline-wrapper {
  flex-shrink: 0;
  background: var(--p-surface-card, #fff);
  border-top: 1px solid var(--p-content-border-color, #dee2e6);
}

.trip-timeline-header {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.trip-timeline-album-name {
  font-size: 0.85rem;
  font-weight: 600;
  flex-shrink: 0;
}

.trip-timeline-album-desc {
  font-size: 0.8rem;
  color: var(--p-text-muted-color, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trip-timeline {
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
  padding: 0.35rem 0.5rem 0.5rem;
  scrollbar-width: thin;
  scroll-behavior: smooth;
}

.trip-timeline-day-group {
  display: flex;
  align-items: stretch;
  position: relative;
  flex-shrink: 0;
}

.trip-timeline-day-group--expanded {
  padding: 0 0.25rem;
  border-radius: 10px;
  background: var(--p-content-hover-background, rgba(0, 0, 0, 0.03));
}

.trip-timeline::-webkit-scrollbar {
  height: 4px;
}

.trip-timeline::-webkit-scrollbar-thumb {
  background: var(--p-content-border-color, #ccc);
  border-radius: 2px;
}

.trip-timeline-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 90px;
  max-width: 110px;
  padding: 0.4rem;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, transform 0.15s;
  flex-shrink: 0;
}

.trip-timeline-item:hover {
  background: var(--p-content-hover-background, rgba(0,0,0,0.04));
}

.trip-timeline-item--selected {
  background: var(--p-primary-50, rgba(66,133,244,0.1));
  outline: 2px solid var(--p-primary-color, #4285F4);
  outline-offset: -2px;
}

.trip-timeline-thumb {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  overflow: hidden;
  border: 2px solid var(--p-content-border-color, #dee2e6);
  flex-shrink: 0;
  margin-bottom: 0.3rem;
}

.trip-timeline-item--selected .trip-timeline-thumb {
  border-color: var(--p-primary-color, #4285F4);
}

.trip-timeline-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.trip-timeline-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 1px;
  min-width: 0;
  width: 100%;
}

.trip-timeline-label {
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.trip-timeline-date {
  font-size: 0.65rem;
  color: var(--p-text-muted-color, #999);
}

.trip-timeline-count {
  font-size: 0.6rem;
  color: var(--p-text-muted-color, #aaa);
}

.trip-timeline-connector {
  position: absolute;
  top: calc(0.4rem + 28px);
  right: -12px;
  width: 24px;
  height: 3px;
  border-radius: 2px;
  opacity: 0.5;
  z-index: 1;
}

.trip-timeline-connector--sibling {
  position: absolute;
  top: calc(0.4rem + 28px);
  left: -10px;
  right: auto;
  width: 14px;
  height: 3px;
  opacity: 0.7;
}

/* Expandable day card marker */
.trip-timeline-item--expandable {
  cursor: pointer;
}

.trip-timeline-item--expandable .trip-timeline-thumb {
  border-color: var(--p-primary-color, #4285F4);
}

.trip-timeline-item--expanded .trip-timeline-thumb {
  border-style: solid;
}

/* Wrapper around the thumb so that the stack-hint and day-badge can
   escape the overflow:hidden of the round thumb. */
.trip-timeline-thumb-wrap {
  position: relative;
  width: 56px;
  height: 56px;
  margin-bottom: 0.3rem;
  flex-shrink: 0;
}

.trip-timeline-thumb-wrap .trip-timeline-thumb {
  margin-bottom: 0;
  position: relative;
  z-index: 1;
}

/* Stacked-cards hint behind the thumb when collapsed */
.trip-timeline-stack-hint {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid var(--p-primary-color, #4285F4);
  opacity: 0.55;
  z-index: 0;
  pointer-events: none;
}

/* Badge showing number of stops per day on the day-cover thumb */
.trip-timeline-day-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  z-index: 2;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--p-primary-color, #4285F4);
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}

.trip-timeline-chevron {
  font-size: 0.85rem;
  line-height: 0.85rem;
  color: var(--p-primary-color, #4285F4);
  font-weight: 700;
  transition: transform 0.15s ease;
  margin-top: 1px;
}

.trip-timeline-chevron--open {
  transform: rotate(90deg);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 768px) {
  .trip-map-container {
    border-radius: 0;
  }

  .trip-timeline-item {
    min-width: 76px;
    max-width: 90px;
  }

  .trip-timeline-thumb {
    width: 44px;
    height: 44px;
  }

  .trip-timeline-thumb-wrap {
    width: 44px;
    height: 44px;
  }

  .trip-timeline-stack-hint {
    width: 44px;
    height: 44px;
  }

  .trip-timeline-connector {
    top: calc(0.4rem + 22px);
  }

  .trip-timeline-wrapper {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}
</style>

<!-- Global styles for Leaflet custom elements (not scoped) -->
<style>
.trip-pin-icon {
  background: none !important;
  border: none !important;
}

.trip-pin-container {
  position: relative;
  width: 48px;
  height: 56px;
  transition: transform 0.2s;
}

.trip-pin-container.trip-pin-selected {
  transform: scale(1.25);
  z-index: 1000 !important;
}

.trip-pin-selected .trip-pin-thumbnail {
  border-color: var(--p-primary-color, #4285F4);
  box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.3), 0 2px 8px rgba(0, 0, 0, 0.3);
}

.trip-pin-thumbnail {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  border: 3px solid white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  background: #333;
}

.trip-pin-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.trip-pin-pointer {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 8px solid white;
}

.trip-pin-selected .trip-pin-pointer {
  border-top-color: var(--p-primary-color, #4285F4);
}

.trip-pin-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--p-primary-color, #4285F4);
  color: white;
  font-size: 0.7rem;
  font-weight: 600;
  min-width: 18px;
  height: 18px;
  line-height: 18px;
  text-align: center;
  border-radius: 9px;
  padding: 0 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

/* Popup styles */
.trip-popup-wrapper .leaflet-popup-content-wrapper {
  border-radius: 10px;
  overflow: hidden;
  padding: 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}

.trip-popup-wrapper .leaflet-popup-content {
  margin: 0;
  min-width: 200px;
}

.trip-popup {
  display: flex;
  flex-direction: column;
}

.trip-popup-img {
  width: 100%;
  max-height: 180px;
  object-fit: cover;
  display: block;
}

.trip-popup-info {
  padding: 10px 12px;
}

.trip-popup-label {
  font-weight: 600;
  font-size: 0.9rem;
  color: #333;
}

.trip-popup-date {
  font-size: 0.8rem;
  color: #666;
  margin-top: 2px;
}

.trip-popup-count {
  font-size: 0.75rem;
  color: #999;
  margin-top: 4px;
}
</style>
