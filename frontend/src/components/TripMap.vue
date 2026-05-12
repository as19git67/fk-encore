<script lang="ts" setup>
import { ref, computed, toRef, onMounted, onUnmounted, watch, nextTick } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Photo } from '../api/photos'
import { getPhotoUrl } from '../api/photos'
import { usePhotoStops, type Stop, type OverviewCluster } from '../composables/usePhotoStops'

const props = defineProps<{
  photos: Photo[]
  albumName?: string
  albumDescription?: string
}>()

const emit = defineEmits<{
  /** Day-scoped photos for fullscreen viewing. The user can only step
   *  through photos of the currently selected day. `day` is the day key
   *  the scope was built from. */
  'open-fullscreen': [dayPhotos: Photo[], startIndex: number, day: string]
  /** Fired when the user actively selects a stop (click or keyboard).
   *  Carries the cover photo id of the chosen stop so the parent can
   *  keep its grid selection in sync when the user flips back to gallery
   *  view. */
  'stop-selected': [coverPhotoId: number]
}>()

const {
  stops,
  stopsByDay,
  dayPaths,
  dayTransitions,
  dayColorMap,
  uniqueDays,
  bounds,
  overviewClusters,
  boundsForDay,
} = usePhotoStops(toRef(props, 'photos'))

const mapContainer = ref<HTMLElement | null>(null)
const timelineContainer = ref<HTMLElement | null>(null)
let map: L.Map | null = null
const markers: L.Marker[] = []
const polylines: L.Polyline[] = []

const OVERVIEW = '__overview__'
type DaySelection = typeof OVERVIEW | string

/** Currently selected timeline entry. Defaults to the overview so the
 *  user lands on a full-trip view. */
const selectedDay = ref<DaySelection>(OVERVIEW)
/** Highlighted stop within the selected day. Only meaningful when a
 *  specific day is selected; null in overview mode. */
const selectedStopId = ref<number | null>(null)

function formatDayLabel(day: string): string {
  // day = YYYY-MM-DD → DD. Mon
  const d = new Date(day + 'T00:00:00')
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
}

function dayPhotoCount(day: string): number {
  const dayStops = stopsByDay.value.get(day) ?? []
  return dayStops.reduce((sum, s) => sum + s.photos.length, 0)
}

function getStopLabel(stop: Stop): string {
  if (stop.locationLabel) return stop.locationLabel
  return `Stopp ${stop.id + 1}`
}

function formatStopDate(stop: Stop): string {
  const date = new Date(stop.coverPhoto.taken_at || stop.coverPhoto.created_at)
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
}

// ── Selection ────────────────────────────────────────────────────────────────

function selectOverview() {
  selectedDay.value = OVERVIEW
  selectedStopId.value = null
  renderContent()
  fitMapToSelection()
  nextTick(() => scrollTimelineToSelection())
}

function selectDay(day: string) {
  if (!uniqueDays.value.includes(day)) return
  selectedDay.value = day
  const first = stopsByDay.value.get(day)?.[0]
  selectedStopId.value = first?.id ?? null
  renderContent()
  fitMapToSelection()
  if (first) emit('stop-selected', first.coverPhoto.id)
  nextTick(() => scrollTimelineToSelection())
}

function selectStopWithinDay(stop: Stop, opts: { silent?: boolean } = {}) {
  const dayChanged = selectedDay.value !== stop.day
  selectedDay.value = stop.day
  selectedStopId.value = stop.id
  renderContent()
  if (!opts.silent) emit('stop-selected', stop.coverPhoto.id)
  // Only re-fit the map when the day actually changes. Tapping a different
  // stop within the already-active day must keep the existing view so the
  // user keeps seeing every cluster of the day, not just the one they
  // tapped.
  if (dayChanged) fitMapToSelection()
  nextTick(() => scrollTimelineToSelection())
}

function fitMapToSelection() {
  if (!map) return
  if (selectedDay.value === OVERVIEW) {
    if (bounds.value) map.fitBounds(bounds.value, { padding: [24, 24] })
    return
  }
  const b = boundsForDay(selectedDay.value)
  if (b) map.fitBounds(b, { padding: [32, 32] })
}

function scrollTimelineToSelection() {
  const container = timelineContainer.value
  if (!container) return
  let el: HTMLElement | null = null
  if (selectedStopId.value != null) {
    el = container.querySelector(`[data-stop-id="${selectedStopId.value}"]`) as HTMLElement | null
  }
  if (!el && selectedDay.value !== OVERVIEW) {
    el = container.querySelector(`[data-day="${selectedDay.value}"]`) as HTMLElement | null
  }
  if (!el && selectedDay.value === OVERVIEW) {
    el = container.querySelector('[data-overview]') as HTMLElement | null
  }
  if (!el) return
  // The day-group wrapper isn't positioned, so `el.offsetLeft` accumulates
  // up to <body> and produces useless numbers. Compute the position from
  // the live rects instead and clamp into the valid scroll range so the
  // last cards in the timeline actually reach the centre.
  const containerRect = container.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const elLeftInContainer = (elRect.left - containerRect.left) + container.scrollLeft
  const target = elLeftInContainer - container.clientWidth / 2 + elRect.width / 2
  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth)
  container.scrollTo({ left: Math.max(0, Math.min(target, maxScroll)), behavior: 'smooth' })
}

// ── Pin rendering ────────────────────────────────────────────────────────────

interface Pin {
  key: string
  lat: number
  lng: number
  cover: Photo
  count: number
  selected: boolean
  onClick: () => void
}

const visiblePins = computed<Pin[]>(() => {
  if (selectedDay.value === OVERVIEW) {
    return overviewClusters.value.map<Pin>(c => ({
      key: `o-${c.id}`,
      lat: c.lat,
      lng: c.lng,
      cover: c.coverPhoto,
      count: c.photos.length,
      selected: false,
      onClick: () => handleOverviewPinClick(c),
    }))
  }
  const day = selectedDay.value
  const dayStops = stopsByDay.value.get(day) ?? []
  return dayStops.map<Pin>(s => ({
    key: `s-${s.id}`,
    lat: s.lat,
    lng: s.lng,
    cover: s.coverPhoto,
    count: s.photos.length,
    selected: s.id === selectedStopId.value,
    onClick: () => handleStopPinClick(s),
  }))
})

function handleOverviewPinClick(c: OverviewCluster) {
  // Drill into the day of the cluster's cover photo. This switches the
  // map into day mode so the user can then click an individual stop.
  const day = (() => {
    const cover = c.coverPhoto
    const fromStop = stops.value.find(s => s.id === c.stopIds[0])
    return fromStop?.day ?? (cover.taken_at || cover.created_at).slice(0, 10)
  })()
  if (uniqueDays.value.includes(day)) selectDay(day)
}

function handleStopPinClick(stop: Stop) {
  selectStopWithinDay(stop)
  // Open fullscreen with the entire selected day's photos so the user can
  // browse within the day. startIndex points at this stop's first photo.
  const dayPhotos = dayPhotosFor(stop.day)
  const startId = stop.photos[0]?.id
  const startIndex = startId != null
    ? Math.max(0, dayPhotos.findIndex(p => p.id === startId))
    : 0
  emit('open-fullscreen', dayPhotos, startIndex, stop.day)
}

function dayPhotosFor(day: string): Photo[] {
  const dayStops = stopsByDay.value.get(day) ?? []
  const out: Photo[] = []
  for (const s of dayStops) {
    for (const p of s.photos) out.push(p)
  }
  return out
}

interface DrawablePin {
  lat: number
  lng: number
  cover: Photo
  /** Total photo count across all merged members. */
  count: number
  selected: boolean
  onClick: () => void
}

/**
 * Pin diameter (px) the visual merger uses as the minimum centre-to-
 * centre distance below which two pins are considered to overlap and get
 * merged into one. The pin thumbnail itself is 48 px; we add a bit of
 * breathing room so adjacent pins don't visually touch.
 */
const PIN_OVERLAP_PX = 60

/**
 * Merge pins whose on-screen positions are closer than `PIN_OVERLAP_PX`
 * at the map's current zoom level. Without this an album with many
 * stops at the same town would render as a wall of overlapping
 * thumbnails — especially on small screens, where the pin size eats a
 * meaningful chunk of the viewport. Merging is greedy: repeatedly pick
 * the closest pair within the threshold, merge their centroids
 * (weighted by photo count) and continue until no overlapping pair
 * remains.
 */
function mergeOverlappingPins(basePins: Pin[]): DrawablePin[] {
  const passthrough = (): DrawablePin[] => basePins.map(p => ({
    lat: p.lat,
    lng: p.lng,
    cover: p.cover,
    count: p.count,
    selected: p.selected,
    onClick: p.onClick,
  }))
  if (!map || basePins.length === 0) return passthrough()
  // The map's pixel projection only works once a view has been
  // established (setView / fitBounds). The very first renderContent()
  // can run before that and would otherwise throw from
  // latLngToContainerPoint. Fall back to no-merge in that case — the
  // zoomend listener will re-render properly once the initial fit lands.
  try {
    map.latLngToContainerPoint([basePins[0]!.lat, basePins[0]!.lng])
  } catch {
    return passthrough()
  }
  interface Work {
    lat: number
    lng: number
    cover: Photo
    count: number
    members: Pin[]
    selected: boolean
  }
  const work: Work[] = basePins.map(p => ({
    lat: p.lat,
    lng: p.lng,
    cover: p.cover,
    count: p.count,
    members: [p],
    selected: p.selected,
  }))

  let changed = true
  while (changed && work.length > 1) {
    changed = false
    let bestI = -1
    let bestJ = -1
    let bestDist = Infinity
    for (let i = 0; i < work.length; i++) {
      const pi = map.latLngToContainerPoint([work[i]!.lat, work[i]!.lng])
      for (let j = i + 1; j < work.length; j++) {
        const pj = map.latLngToContainerPoint([work[j]!.lat, work[j]!.lng])
        const d = pi.distanceTo(pj)
        if (d < bestDist) {
          bestDist = d
          bestI = i
          bestJ = j
        }
      }
    }
    if (bestDist < PIN_OVERLAP_PX && bestI >= 0) {
      const a = work[bestI]!
      const b = work[bestJ]!
      const total = a.count + b.count
      a.lat = (a.lat * a.count + b.lat * b.count) / total
      a.lng = (a.lng * a.count + b.lng * b.count) / total
      a.count = total
      a.members = a.members.concat(b.members)
      a.selected = a.selected || b.selected
      // Best cover among all merged members so the visible thumbnail
      // remains representative of the largest/highest-quality stop.
      a.cover = a.members.reduce<Photo>((best, m) => {
        return (m.cover.ai_quality_score ?? 0) > (best.ai_quality_score ?? 0)
          ? m.cover
          : best
      }, a.members[0]!.cover)
      work.splice(bestJ, 1)
      changed = true
    }
  }

  return work.map(w => ({
    lat: w.lat,
    lng: w.lng,
    cover: w.cover,
    count: w.count,
    selected: w.selected,
    // For merged pins fall back to the first member's click handler — that
    // member drives the selection model (timeline scroll, fullscreen open)
    // and keeps the UX consistent with unmerged pins.
    onClick: () => w.members[0]!.onClick(),
  }))
}

function createPinIcon(pin: DrawablePin): L.DivIcon {
  const url = getPhotoUrl(pin.cover.filename, 96)
  const badge = pin.count > 1 ? `<span class="trip-pin-badge">${pin.count}</span>` : ''
  const selectedClass = pin.selected ? ' trip-pin-selected' : ''

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

// ── Map ──────────────────────────────────────────────────────────────────────

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

  // Pixel-space merging depends on the current zoom: zooming in spreads
  // pins apart and reveals previously-merged stops, zooming out merges
  // more aggressively. Re-render the markers after every zoom change so
  // the visible pins always reflect what fits on screen.
  map.on('zoomend', () => renderContent())

  renderContent()
  fitMapToSelection()
}

function clearContent() {
  for (const m of markers) m.remove()
  markers.length = 0
  for (const p of polylines) p.remove()
  polylines.length = 0
}

function renderContent() {
  if (!map) return
  clearContent()

  if (selectedDay.value === OVERVIEW) {
    // Inter-day jumps that survived the distance threshold.
    for (const transition of dayTransitions.value) {
      const line = L.polyline(transition.coordinates, {
        color: transition.color,
        weight: 2,
        opacity: 0.5,
        dashArray: '8, 8',
      }).addTo(map)
      polylines.push(line)
    }
  } else {
    // Only the selected day's within-day path.
    const path = dayPaths.value.find(p => p.day === selectedDay.value)
    if (path && path.coordinates.length >= 2) {
      const line = L.polyline(path.coordinates, {
        color: path.color,
        weight: 3,
        opacity: 0.8,
      }).addTo(map)
      polylines.push(line)
    }
  }

  for (const pin of mergeOverlappingPins(visiblePins.value)) {
    const marker = L.marker([pin.lat, pin.lng], { icon: createPinIcon(pin) }).addTo(map)
    marker.on('click', pin.onClick)
    markers.push(marker)
  }
}

// ── Keyboard navigation between stops ────────────────────────────────────────

function navigateToPrev() {
  if (selectedDay.value === OVERVIEW) return
  const dayStops = stopsByDay.value.get(selectedDay.value) ?? []
  if (dayStops.length === 0) return
  if (selectedStopId.value == null) {
    selectStopWithinDay(dayStops[0]!)
    return
  }
  const idx = dayStops.findIndex(s => s.id === selectedStopId.value)
  if (idx > 0) selectStopWithinDay(dayStops[idx - 1]!)
}

function navigateToNext() {
  if (selectedDay.value === OVERVIEW) return
  const dayStops = stopsByDay.value.get(selectedDay.value) ?? []
  if (dayStops.length === 0) return
  if (selectedStopId.value == null) {
    selectStopWithinDay(dayStops[0]!)
    return
  }
  const idx = dayStops.findIndex(s => s.id === selectedStopId.value)
  if (idx >= 0 && idx < dayStops.length - 1) selectStopWithinDay(dayStops[idx + 1]!)
}

function handleKeydown(e: KeyboardEvent) {
  if (selectedDay.value === OVERVIEW) return
  if (e.key === 'ArrowLeft') { e.preventDefault(); navigateToPrev() }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigateToNext() }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  await nextTick()
  initMap()
  window.addEventListener('keydown', handleKeydown)
  nextTick(() => scrollTimelineToSelection())
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})

watch(() => props.photos, () => {
  selectedDay.value = OVERVIEW
  selectedStopId.value = null
  renderContent()
  fitMapToSelection()
  nextTick(() => scrollTimelineToSelection())
}, { deep: true })

// Re-render when selection or the underlying clustering changes.
watch(visiblePins, () => {
  renderContent()
})

// ── External API ─────────────────────────────────────────────────────────────

/**
 * Select the stop that contains the given photo, if any. Used by the
 * parent view to sync the map selection with the photo the user ended on
 * in the fullscreen overlay. Switches to the matching day and centres
 * the timeline on the stop.
 */
function selectStopByPhotoId(photoId: number): boolean {
  const stop = stops.value.find((s) => s.photos.some((p) => p.id === photoId))
  if (!stop) return false
  selectStopWithinDay(stop, { silent: true })
  return true
}

defineExpose({ selectStopByPhotoId })
</script>

<template>
  <div class="trip-map-wrapper">
    <div ref="mapContainer" class="trip-map-container" />

    <!-- Stats overlay — two rows: counts on top, slot addon below. -->
    <div class="trip-stats">
      <div class="trip-stats-row">
        <span>{{ stops.length }} {{ stops.length === 1 ? 'Stopp' : 'Stopps' }}</span>
        <span class="trip-stats-sep">&bull;</span>
        <span>{{ photos.filter(p => p.latitude != null).length }} Fotos</span>
      </div>
      <div v-if="$slots['stats-addon']" class="trip-stats-row">
        <slot name="stats-addon" />
      </div>
    </div>

    <!-- Horizontal timeline strip -->
    <div v-if="stops.length > 0" class="trip-timeline-wrapper">
      <div v-if="albumName" class="trip-timeline-header">
        <span class="trip-timeline-album-name">{{ albumName }}</span>
        <span v-if="albumDescription" class="trip-timeline-album-desc">— {{ albumDescription }}</span>
      </div>
      <div ref="timelineContainer" class="trip-timeline">
        <!-- Overview / whole-trip card -->
        <div
          data-overview
          :class="[
            'trip-timeline-item',
            'trip-timeline-item--overview',
            { 'trip-timeline-item--selected': selectedDay === '__overview__' },
          ]"
          :title="'Ganze Reise auf der Karte'"
          @click="selectOverview"
        >
          <div class="trip-timeline-overview-icon">
            <i class="pi pi-globe" aria-hidden="true" />
          </div>
          <div class="trip-timeline-info">
            <span class="trip-timeline-label">Übersicht</span>
            <span class="trip-timeline-date">
              {{ uniqueDays.length }} {{ uniqueDays.length === 1 ? 'Tag' : 'Tage' }}
            </span>
          </div>
        </div>

        <template v-for="day in uniqueDays" :key="day">
          <div
            class="trip-timeline-day-group"
            :class="{ 'trip-timeline-day-group--expanded': selectedDay === day }"
            :data-day="day"
          >
            <!-- Day cover card -->
            <div
              v-if="stopsByDay.get(day) && stopsByDay.get(day)!.length > 0"
              :data-stop-id="stopsByDay.get(day)![0]!.id"
              :class="[
                'trip-timeline-item',
                'trip-timeline-item--day',
                {
                  'trip-timeline-item--selected':
                    selectedDay === day && stopsByDay.get(day)![0]!.id === selectedStopId,
                  'trip-timeline-item--day-active': selectedDay === day,
                  'trip-timeline-item--expandable': stopsByDay.get(day)!.length > 1,
                },
              ]"
              :title="formatDayLabel(day)"
              @click="selectDay(day)"
            >
              <div class="trip-timeline-thumb-wrap">
                <div
                  v-if="stopsByDay.get(day)!.length > 1 && selectedDay !== day"
                  class="trip-timeline-stack-hint"
                  :style="{ borderColor: dayColorMap.get(day) }"
                />
                <div class="trip-timeline-thumb">
                  <img
                    :src="getPhotoUrl(stopsByDay.get(day)![0]!.coverPhoto.filename, 96)"
                    :alt="formatDayLabel(day)"
                  />
                </div>
                <span
                  v-if="stopsByDay.get(day)!.length > 1"
                  class="trip-timeline-day-badge"
                  :style="{ background: dayColorMap.get(day) }"
                >{{ stopsByDay.get(day)!.length }}</span>
              </div>
              <div class="trip-timeline-info">
                <span class="trip-timeline-label">{{ formatDayLabel(day) }}</span>
                <span class="trip-timeline-date">
                  <template v-if="selectedDay === day && stopsByDay.get(day)!.length > 1">
                    {{ dayPhotoCount(day) }}
                    {{ dayPhotoCount(day) === 1 ? 'Foto' : 'Fotos' }}
                  </template>
                  <template v-else>
                    {{ stopsByDay.get(day)!.length }}
                    {{ stopsByDay.get(day)!.length === 1 ? 'Stopp' : 'Stopps' }}
                  </template>
                </span>
              </div>
            </div>

            <!-- Sibling stops of the active day -->
            <template v-if="selectedDay === day && (stopsByDay.get(day)?.length ?? 0) > 1">
              <div
                v-for="(stop, sIdx) in stopsByDay.get(day)!.slice(1)"
                :key="stop.id"
                :data-stop-id="stop.id"
                :class="[
                  'trip-timeline-item',
                  'trip-timeline-item--sibling',
                  { 'trip-timeline-item--selected': stop.id === selectedStopId },
                ]"
                @click="selectStopWithinDay(stop)"
              >
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
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  padding: 6px 12px;
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.85rem;
}

.trip-stats-row {
  display: flex;
  align-items: center;
  gap: 8px;
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
  color: var(--p-text-color);
}

.trip-timeline-album-desc {
  font-size: 0.8rem;
  color: color-mix(in srgb, var(--p-text-color) 70%, transparent);
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

.trip-timeline-item--day-active:not(.trip-timeline-item--selected) {
  background: var(--p-content-hover-background, rgba(0,0,0,0.03));
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

.trip-timeline-item--expandable {
  cursor: pointer;
}

.trip-timeline-item--expandable .trip-timeline-thumb {
  border-color: var(--p-primary-color, #4285F4);
}

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

/* ── Overview card ──────────────────────────────────────────────────────── */
.trip-timeline-item--overview .trip-timeline-overview-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  color: var(--p-primary-color, #4285F4);
  border: 2px solid var(--p-primary-color, #4285F4);
  font-size: 1.5rem;
  margin-bottom: 0.3rem;
}

.trip-timeline-item--overview.trip-timeline-item--selected .trip-timeline-overview-icon {
  background: var(--p-primary-color, #4285F4);
  color: #fff;
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

  .trip-timeline-item--overview .trip-timeline-overview-icon {
    width: 44px;
    height: 44px;
    font-size: 1.15rem;
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
</style>
