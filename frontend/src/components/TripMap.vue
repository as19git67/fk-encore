<script lang="ts" setup>
import { ref, toRef, onMounted, watch, nextTick } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Photo } from '../api/photos'
import { getPhotoUrl } from '../api/photos'
import { usePhotoStops, type Stop } from '../composables/usePhotoStops'
import TripMapNoGpsPanel from './TripMapNoGpsPanel.vue'

const props = defineProps<{
  photos: Photo[]
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

  if (panMap) {
    map.flyTo([stop.lat, stop.lng], Math.max(map.getZoom(), 13), { duration: 0.5 })
  }

  // Scroll timeline to selected stop
  scrollTimelineToStop(stopId)
}

function scrollTimelineToStop(stopId: number) {
  const container = timelineContainer.value
  if (!container) return
  const el = container.querySelector(`[data-stop-id="${stopId}"]`) as HTMLElement | null
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

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
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

// ── Legend ────────────────────────────────────────────────────────────────────

function formatDay(day: string): string {
  return new Date(day + 'T00:00:00').toLocaleDateString('de-DE', {
    day: '2-digit',
    month: 'short',
  })
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  await nextTick()
  initMap()
})

watch(() => props.photos, () => {
  renderContent()
}, { deep: true })

function handleNoGpsPhotoClick(photo: Photo) {
  emit('open-fullscreen', [photo], 0)
}
</script>

<template>
  <div class="trip-map-wrapper">
    <div ref="mapContainer" class="trip-map-container" />

    <!-- Day legend -->
    <div v-if="uniqueDays.length > 1" class="trip-legend">
      <div v-for="day in uniqueDays" :key="day" class="trip-legend-item">
        <span class="trip-legend-dot" :style="{ background: dayColorMap.get(day) }" />
        <span class="trip-legend-label">{{ formatDay(day) }}</span>
      </div>
    </div>

    <!-- Stats overlay -->
    <div class="trip-stats">
      <span>{{ stops.length }} {{ stops.length === 1 ? 'Stopp' : 'Stopps' }}</span>
      <span class="trip-stats-sep">&bull;</span>
      <span>{{ photos.filter(p => p.latitude != null).length }} Fotos</span>
    </div>

    <!-- Horizontal timeline strip -->
    <div v-if="stops.length > 0" ref="timelineContainer" class="trip-timeline">
      <div
        v-for="(stop, index) in stops"
        :key="stop.id"
        :data-stop-id="stop.id"
        :class="['trip-timeline-item', { 'trip-timeline-item--selected': stop.id === selectedStopId }]"
        @click="selectStop(stop.id)"
      >
        <div class="trip-timeline-thumb">
          <img :src="getPhotoUrl(stop.coverPhoto.filename, 96)" :alt="getStopLabel(stop)" />
        </div>
        <div class="trip-timeline-info">
          <span class="trip-timeline-label">{{ getStopLabel(stop) }}</span>
          <span class="trip-timeline-date">{{ formatStopDate(stop) }}</span>
          <span class="trip-timeline-count">{{ stop.photos.length }} {{ stop.photos.length === 1 ? 'Foto' : 'Fotos' }}</span>
        </div>
        <!-- Connector line between items -->
        <div
          v-if="index < stops.length - 1"
          class="trip-timeline-connector"
          :style="{ background: dayColorMap.get(stop.day) }"
        />
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

/* Legend */
.trip-legend {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trip-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.trip-legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.trip-legend-label {
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.8rem;
  white-space: nowrap;
}

/* Stats */
.trip-stats {
  position: absolute;
  top: 12px;
  left: 12px;
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
.trip-timeline {
  display: flex;
  gap: 0;
  overflow-x: auto;
  padding: 0.75rem 0.5rem;
  background: var(--p-surface-card, #fff);
  border-top: 1px solid var(--p-content-border-color, #dee2e6);
  scrollbar-width: thin;
  scroll-behavior: smooth;
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

  .trip-timeline-connector {
    top: calc(0.4rem + 22px);
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
