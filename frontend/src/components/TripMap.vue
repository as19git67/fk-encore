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
  /** Photos for fullscreen viewing — the entire trip in chronological
   *  order (across all days and stops) so paging and the idle slideshow
   *  run continuously without stopping at a day/stop boundary. `day` is
   *  the day key of the stop the overlay was opened from. */
  'open-fullscreen': [photos: Photo[], startIndex: number, day: string]
  /** Fired when the user actively selects a stop (click or keyboard).
   *  Carries the cover photo id of the chosen stop so the parent can
   *  keep its grid selection in sync when the user flips back to gallery
   *  view. */
  'stop-selected': [coverPhotoId: number]
}>()

// Cluster radius in meters, derived from the map's live zoom (see
// updateClusterRadius). Drives usePhotoStops so timeline stops and day-mode map
// pins share one clustering pass and stay 1:1 in sync at every zoom level.
// Null until the map has a view (then the day-span heuristic is used).
const clusterRadiusMeters = ref<number | null>(null)

const {
  stops,
  stopsByDay,
  longJumps,
  dayColorMap,
  uniqueDays,
  bounds,
  overviewClusters,
  boundsForDay,
} = usePhotoStops(toRef(props, 'photos'), clusterRadiusMeters)

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
/** Cover-photo id of the selected stop. Stop ids are reassigned whenever the
 *  zoom-driven clustering recomputes, so we re-resolve the selection by this
 *  stable photo id instead of losing it on every zoom (see watch on `stops`). */
const selectedAnchorPhotoId = ref<number | null>(null)
/** A specific pre-selected photo (deep link, last-viewed restore).
 *  When set, clicking the pin of the containing stop opens fullscreen
 *  at THIS photo instead of the stop's first photo. Cleared as soon
 *  as the user navigates somewhere else. */
const activePhotoId = ref<number | null>(null)

function getStopLabel(stop: Stop): string {
  if (stop.locationLabel) return stop.locationLabel
  return `Stopp ${stop.id + 1}`
}

function formatStopDate(stop: Stop): string {
  const date = new Date(stop.coverPhoto.taken_at || stop.coverPhoto.created_at)
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
}

// ── Selection ────────────────────────────────────────────────────────────────
//
// The whole timeline is scroll-driven: whichever card is closest to the
// viewport centre becomes the active selection. Tapping a card simply
// scrolls it to centre, which then triggers the same selection logic.
//
// To avoid yanking cards out from under the user's finger when a day
// collapses/expands, day changes are deferred until the scroll
// SETTLES ('scrollend' or fallback timer). While the user is still
// dragging we only update within-day state — `selectedStopId` — so the
// map's pin highlight tracks the scroll live but the timeline DOM
// stays put.

let scrollRaf = 0
let scrollEndFallbackTimer: ReturnType<typeof setTimeout> | null = null
/** Browsers that haven't shipped native 'scrollend' get this debounce
 *  approximation: after this long with no further scroll event we
 *  assume the scroll has settled. */
const SCROLL_END_FALLBACK_MS = 180

function applySelection(
  day: DaySelection,
  stopId: number | null,
  opts: { silent?: boolean } = {},
) {
  const dayChanged = selectedDay.value !== day
  const stopChanged = selectedStopId.value !== stopId
  if (!dayChanged && !stopChanged) return
  // Drop the active-photo hint whenever we move to a stop that doesn't
  // contain it. The hint only applies to the stop that owns the photo
  // — every other navigation cancels it so subsequent pin clicks open
  // at the stop's first photo instead.
  if (stopChanged && activePhotoId.value != null) {
    const targetStop = stopId != null ? stops.value.find(s => s.id === stopId) : null
    if (!targetStop || !targetStop.photos.some(p => p.id === activePhotoId.value)) {
      activePhotoId.value = null
    }
  }
  selectedDay.value = day
  selectedStopId.value = stopId
  // Remember the stop's cover photo so the selection survives a zoom-driven
  // re-clustering (which reassigns stop ids).
  selectedAnchorPhotoId.value = stopId != null
    ? (stops.value.find(s => s.id === stopId)?.coverPhoto.id ?? null)
    : null
  renderContent()
  if (dayChanged) fitMapToSelection()
  if (!opts.silent && stopId != null) {
    const stop = stops.value.find(s => s.id === stopId)
    if (stop) emit('stop-selected', stop.coverPhoto.id)
  }
}

function fitMapToSelection() {
  if (!map) return
  const b = selectedDay.value === OVERVIEW
    ? bounds.value
    : boundsForDay(selectedDay.value)
  if (b) {
    map.fitBounds(b, { padding: [24, 24], maxZoom: 16 })
  } else {
    // Without a view Leaflet renders neither tiles nor markers. Fall
    // back to a centred-on-Germany view so the map at least shows map
    // details when the album has no GPS-tagged photos (or none yet).
    map.setView([51.1657, 10.4515], 5)
  }
}

/** Identify the timeline card whose centre is closest to the viewport
 *  centre. Used by both the scroll listener (live tracking) and by the
 *  layout-shift compensator (anchor measurement). */
function findCenteredItem(): { type: 'overview' } | { type: 'stop'; stop: Stop } | null {
  const container = timelineContainer.value
  if (!container) return null
  const cRect = container.getBoundingClientRect()
  const centerX = cRect.left + container.clientWidth / 2

  let best: { type: 'overview' } | { type: 'stop'; stop: Stop } | null = null
  let bestDist = Infinity

  const overviewEl = container.querySelector('[data-overview]') as HTMLElement | null
  if (overviewEl) {
    const r = overviewEl.getBoundingClientRect()
    const d = Math.abs((r.left + r.width / 2) - centerX)
    if (d < bestDist) {
      bestDist = d
      best = { type: 'overview' }
    }
  }

  const stopEls = container.querySelectorAll('[data-stop-id]')
  for (let i = 0; i < stopEls.length; i++) {
    const el = stopEls[i] as HTMLElement
    const r = el.getBoundingClientRect()
    const d = Math.abs((r.left + r.width / 2) - centerX)
    if (d < bestDist) {
      const sid = parseInt(el.dataset.stopId!, 10)
      const stop = stops.value.find(s => s.id === sid)
      if (stop) {
        bestDist = d
        best = { type: 'stop', stop }
      }
    }
  }
  return best
}

function onTimelineScroll() {
  if (!scrollRaf) {
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0
      // Live: only follow within the already-active day. Day-level
      // changes wait for the scroll to settle.
      applyScrollDrivenSelection(false)
    })
  }
  // Native scrollend isn't universally supported yet — use a debounce
  // timer as a fallback. When native scrollend fires it will also call
  // onTimelineScrollEnd, which clears this timer to avoid a double
  // apply.
  if (scrollEndFallbackTimer != null) clearTimeout(scrollEndFallbackTimer)
  scrollEndFallbackTimer = setTimeout(() => {
    scrollEndFallbackTimer = null
    onTimelineScrollEnd()
  }, SCROLL_END_FALLBACK_MS)
}

function onTimelineScrollEnd() {
  if (scrollEndFallbackTimer != null) {
    clearTimeout(scrollEndFallbackTimer)
    scrollEndFallbackTimer = null
  }
  applyScrollDrivenSelection(true)
}

function applyScrollDrivenSelection(allowDayChange: boolean) {
  const centered = findCenteredItem()
  if (!centered) return

  if (centered.type === 'overview') {
    if (selectedDay.value === OVERVIEW) return
    if (!allowDayChange) return
    applySelection(OVERVIEW, null)
    return
  }

  const stop = centered.stop
  const dayChanged = selectedDay.value !== stop.day

  if (!dayChanged) {
    if (selectedStopId.value !== stop.id) applySelection(stop.day, stop.id)
    return
  }

  // Day-level changes (which trigger collapse/expand) are deferred until
  // the scroll has settled. Mid-drag we leave the timeline DOM alone so
  // cards don't shift out from under the user's finger.
  if (!allowDayChange) return

  // Day transition: the old day's siblings will collapse and the new
  // day's siblings will expand, shifting cards horizontally. Capture
  // the new active card's position before the re-render so we can
  // adjust scrollLeft afterwards and keep it visually centred.
  const container = timelineContainer.value!
  const oldEl = container.querySelector(`[data-stop-id="${stop.id}"]`) as HTMLElement | null
  const cRect = container.getBoundingClientRect()
  const oldScrollPos = oldEl
    ? container.scrollLeft + (oldEl.getBoundingClientRect().left - cRect.left)
    : null

  applySelection(stop.day, stop.id)

  if (oldScrollPos === null) return
  nextTick(() => {
    const newEl = container.querySelector(`[data-stop-id="${stop.id}"]`) as HTMLElement | null
    if (!newEl) return
    const newCRect = container.getBoundingClientRect()
    const newScrollPos = container.scrollLeft + (newEl.getBoundingClientRect().left - newCRect.left)
    const delta = newScrollPos - oldScrollPos
    if (Math.abs(delta) > 1) {
      container.scrollTo({ left: container.scrollLeft + delta, behavior: 'auto' })
    }
  })
}

/** Programmatically scroll the timeline so the named card ends up
 *  centred. Used by tap handlers and by `selectStopByPhotoId` after
 *  the user returns from fullscreen. Uses instant scrolling — smooth
 *  scrolls fire a flood of scroll events that briefly highlight each
 *  card the animation sweeps across. */
function scrollItemIntoCenter(target: number | typeof OVERVIEW) {
  const container = timelineContainer.value
  if (!container) return
  const el = target === OVERVIEW
    ? container.querySelector('[data-overview]') as HTMLElement | null
    : container.querySelector(`[data-stop-id="${target}"]`) as HTMLElement | null
  if (!el) return
  const cRect = container.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const elPosInScroll = container.scrollLeft + (elRect.left - cRect.left)
  const targetScroll = elPosInScroll + elRect.width / 2 - container.clientWidth / 2
  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth)
  const clamped = Math.max(0, Math.min(targetScroll, maxScroll))
  if (Math.abs(clamped - container.scrollLeft) < 1) return
  // Explicit 'auto' — instant scroll. Without this any external CSS
  // `scroll-behavior: smooth` would re-introduce the animated scroll
  // that lets the scroll handler briefly see intermediate cards as
  // the centred one.
  container.scrollTo({ left: clamped, behavior: 'auto' })
}

function handleOverviewTap() {
  applySelection(OVERVIEW, null)
  nextTick(() => scrollItemIntoCenter(OVERVIEW))
}

function handleStopTap(stop: Stop) {
  const dayChanged = selectedDay.value !== stop.day
  applySelection(stop.day, stop.id)
  nextTick(() => {
    scrollItemIntoCenter(stop.id)
    // A day change already reframed the map to the whole day (pin in view).
    // Within the same day, recentre only if the pin scrolled off screen.
    if (!dayChanged) ensureStopPinVisible(stop)
  })
}

/**
 * Pan the map so the stop's pin is centred — but only when it currently sits
 * outside the visible map area. Tapping a stop whose pin is already on screen
 * leaves the view untouched (no needless jump).
 */
function ensureStopPinVisible(stop: Stop) {
  if (!map) return
  const latlng: [number, number] = [stop.lat, stop.lng]
  if (map.getBounds().contains(latlng)) return
  map.panTo(latlng)
}

/**
 * Activation (Enter / Space on a focused stop card): select the stop and, if
 * its pin is off screen, centre the map on it. In day mode every stop is
 * already its own pin (zoom-driven clustering keeps pins and stops 1:1), so
 * there is nothing to "unmerge".
 */
function handleStopActivate(stop: Stop) {
  const dayChanged = selectedDay.value !== stop.day
  applySelection(stop.day, stop.id)
  nextTick(() => {
    scrollItemIntoCenter(stop.id)
    if (!dayChanged) ensureStopPinVisible(stop)
  })
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
  if (!uniqueDays.value.includes(day)) return
  const first = stopsByDay.value.get(day)?.[0]
  if (!first) return
  applySelection(day, first.id)
  nextTick(() => scrollItemIntoCenter(first.id))
}

function handleStopPinClick(stop: Stop) {
  applySelection(stop.day, stop.id)
  nextTick(() => scrollItemIntoCenter(stop.id))
  // Open fullscreen with the entire trip's photos so paging and the idle
  // slideshow run continuously across day/stop boundaries. If we have a
  // pre-selected photo (deep link, last-viewed restore) AND this stop
  // contains it, start at THAT photo instead of the stop's first. Then
  // consume the hint — subsequent clicks default to first-photo behaviour.
  const allPhotos = allStopPhotos.value
  const startId = activePhotoId.value != null
      && stop.photos.some(p => p.id === activePhotoId.value)
    ? activePhotoId.value
    : stop.photos[0]?.id
  const startIndex = startId != null
    ? Math.max(0, allPhotos.findIndex(p => p.id === startId))
    : 0
  activePhotoId.value = null
  emit('open-fullscreen', allPhotos, startIndex, stop.day)
}

/**
 * Every photo across the whole trip in the timeline's chronological order
 * (days ascending, stops within a day by time, photos within a stop by
 * time). Used as the fullscreen scope so the slideshow flows through the
 * entire trip rather than stopping at the end of a single day.
 */
const allStopPhotos = computed<Photo[]>(() => {
  const out: Photo[] = []
  for (const s of stops.value) {
    for (const p of s.photos) out.push(p)
  }
  return out
})

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

  // Establish the initial view BEFORE deriving the cluster radius / first
  // render so projections and zoom-to-meters run against a real zoom level.
  fitMapToSelection()
  updateClusterRadius()
  renderContent()

  // The zoom always drives the cluster radius so the always-expanded
  // timeline's stop count (and photos per stop) follows the zoom factor in
  // both day and overview mode. The `stops` watcher re-renders day-mode pins;
  // overview mode additionally needs an explicit re-render because its pins
  // use the pixel-space merge, which depends on the current zoom.
  map.on('zoomend', () => {
    updateClusterRadius()
    if (selectedDay.value === OVERVIEW) renderContent()
  })
}

/**
 * Project the map's "pins closer than PIN_OVERLAP_PX overlap" threshold into a
 * cluster radius in meters at the current zoom + latitude, and feed it to
 * usePhotoStops. metersPerPixel = 156543.03 · cos(lat) / 2^zoom (Web Mercator).
 * Setting this re-clusters the stops, keeping day-mode pins and the timeline
 * 1:1 at every zoom level.
 */
function updateClusterRadius() {
  if (!map) return
  const zoom = map.getZoom()
  const lat = map.getCenter().lat
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
  clusterRadiusMeters.value = metersPerPixel * PIN_OVERLAP_PX
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

  // Always-dashed lines for the top-10 % of consecutive jumps. In day
  // mode we further restrict to the active day's intra-day jumps —
  // inter-day jumps would extend out of the day's bounds and confuse
  // the focused view.
  const day = selectedDay.value
  for (const jump of longJumps.value) {
    if (day !== OVERVIEW) {
      if (jump.fromDay !== day || jump.toDay !== day) continue
    }
    const line = L.polyline(jump.coordinates, {
      color: jump.color,
      weight: 2,
      opacity: 0.6,
      dashArray: '8, 8',
    }).addTo(map)
    polylines.push(line)
  }

  // Day mode: one marker per stop (zoom-driven clustering already de-clutters,
  // so pins match the timeline 1:1). Overview mode (no timeline) keeps the
  // pixel-space merge to avoid a wall of overlapping thumbnails.
  const drawables = day === OVERVIEW
    ? mergeOverlappingPins(visiblePins.value)
    : visiblePins.value
  for (const pin of drawables) {
    const marker = L.marker([pin.lat, pin.lng], { icon: createPinIcon(pin) }).addTo(map)
    marker.on('click', pin.onClick)
    markers.push(marker)
  }
}

// ── Keyboard navigation between stops ────────────────────────────────────────

function navigateToPrev() {
  const all = stops.value
  if (all.length === 0) return
  if (selectedStopId.value == null) {
    handleStopTap(all[0]!)
    return
  }
  const idx = all.findIndex(s => s.id === selectedStopId.value)
  // Walk one step backwards across the whole chronological list — day
  // boundaries are not a stopping point. When crossing into the
  // previous day handleStopTap takes care of switching `selectedDay`
  // and refitting the map.
  if (idx > 0) handleStopTap(all[idx - 1]!)
}

function navigateToNext() {
  const all = stops.value
  if (all.length === 0) return
  if (selectedStopId.value == null) {
    handleStopTap(all[0]!)
    return
  }
  const idx = all.findIndex(s => s.id === selectedStopId.value)
  if (idx >= 0 && idx < all.length - 1) handleStopTap(all[idx + 1]!)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') { e.preventDefault(); navigateToPrev() }
  else if (e.key === 'ArrowRight') { e.preventDefault(); navigateToNext() }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  await nextTick()
  initMap()
  window.addEventListener('keydown', handleKeydown)
  const container = timelineContainer.value
  if (container) {
    container.addEventListener('scroll', onTimelineScroll, { passive: true })
    container.addEventListener('scrollend', onTimelineScrollEnd)
  }
  // Land on overview at start. The end-spacers (see CSS) make scrollLeft
  // = 0 actually centre the overview card under the viewport centre.
  nextTick(() => scrollItemIntoCenter(OVERVIEW))
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  const container = timelineContainer.value
  if (container) {
    container.removeEventListener('scroll', onTimelineScroll)
    container.removeEventListener('scrollend', onTimelineScrollEnd)
  }
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  if (scrollEndFallbackTimer) clearTimeout(scrollEndFallbackTimer)
})

watch(() => props.photos, () => {
  selectedDay.value = OVERVIEW
  selectedStopId.value = null
  selectedAnchorPhotoId.value = null
  renderContent()
  fitMapToSelection()
  nextTick(() => scrollItemIntoCenter(OVERVIEW))
}, { deep: true })

// The zoom-driven clustering reassigns stop ids on every recompute, so a held
// selection must be re-resolved by its (stable) cover photo — otherwise the
// id would silently point at a different cluster after a zoom. Resolves within
// the selected day; clears the selection if the photo no longer exists.
watch(stops, () => {
  const anchor = selectedAnchorPhotoId.value
  if (anchor == null) { selectedStopId.value = null; return }
  const next = stops.value.find(
    s => s.day === selectedDay.value && s.photos.some(p => p.id === anchor),
  )
  selectedStopId.value = next ? next.id : null
  if (next) selectedAnchorPhotoId.value = next.coverPhoto.id
  else selectedAnchorPhotoId.value = null
})

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
  // Record the specific photo BEFORE applySelection so the stop-change
  // logic inside applySelection sees that the new stop contains the
  // active photo and keeps the hint alive. Without this order the
  // hint would be cleared by the very call that brought us here.
  activePhotoId.value = photoId
  applySelection(stop.day, stop.id, { silent: true })
  nextTick(() => scrollItemIntoCenter(stop.id))
  return true
}

/**
 * Select the stop containing the photo AND open the fullscreen overlay at
 * that photo (scoped to the whole trip, like a pin click). Used for
 * notification deep-links so the visitor lands directly on the commented
 * photo rather than only on its map stop.
 */
function openFullscreenByPhotoId(photoId: number): boolean {
  const stop = stops.value.find((s) => s.photos.some((p) => p.id === photoId))
  if (!stop) return false
  activePhotoId.value = photoId
  applySelection(stop.day, stop.id, { silent: true })
  nextTick(() => scrollItemIntoCenter(stop.id))
  const allPhotos = allStopPhotos.value
  const startIndex = Math.max(0, allPhotos.findIndex((p) => p.id === photoId))
  activePhotoId.value = null
  emit('open-fullscreen', allPhotos, startIndex, stop.day)
  return true
}

defineExpose({ selectStopByPhotoId, openFullscreenByPhotoId })
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
          role="button"
          tabindex="0"
          :class="[
            'trip-timeline-item',
            'trip-timeline-item--overview',
            { 'trip-timeline-item--selected': selectedDay === '__overview__' },
          ]"
          :title="'Ganze Reise auf der Karte'"
          @click="handleOverviewTap"
          @keydown.enter.prevent="handleOverviewTap"
          @keydown.space.prevent="handleOverviewTap"
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

        <!-- Stops are always shown fully expanded: one continuous,
             chronological sequence of every stop across all days. Same-day
             stops are grouped into a subtly-shaded block, with the day's
             colour marking the first stop of each day so day boundaries stay
             readable. The number of stops (and photos per stop) still follows
             the map's zoom-driven clustering. -->
        <template v-for="day in uniqueDays" :key="day">
          <div
            class="trip-timeline-day-group trip-timeline-day-group--expanded"
            :data-day="day"
          >
            <div
              v-for="(stop, sIdx) in stopsByDay.get(day)!"
              :key="stop.id"
              :data-stop-id="stop.id"
              role="button"
              tabindex="0"
              :class="[
                'trip-timeline-item',
                'trip-timeline-item--stop',
                {
                  'trip-timeline-item--selected': stop.id === selectedStopId,
                  'trip-timeline-item--day-first': sIdx === 0,
                },
              ]"
              :title="getStopLabel(stop)"
              :style="{ '--day-color': dayColorMap.get(day) }"
              @click="handleStopTap(stop)"
              @keydown.enter.prevent="handleStopActivate(stop)"
              @keydown.space.prevent="handleStopActivate(stop)"
            >
              <!-- Connector to the previous stop of the same day. -->
              <div
                v-if="sIdx > 0"
                class="trip-timeline-connector trip-timeline-connector--sibling"
                :style="{ background: dayColorMap.get(day) }"
              />
              <div class="trip-timeline-thumb">
                <img :src="getPhotoUrl(stop.coverPhoto.filename, 96)" :alt="getStopLabel(stop)" />
              </div>
              <div class="trip-timeline-info">
                <!-- Every stop — including the first of a day — shows the bold
                     stop label and the date on the line below. -->
                <span class="trip-timeline-label">{{ getStopLabel(stop) }}</span>
                <span class="trip-timeline-date">{{ formatStopDate(stop) }}</span>
                <span class="trip-timeline-count">
                  {{ stop.photos.length }} {{ stop.photos.length === 1 ? 'Foto' : 'Fotos' }}
                </span>
              </div>
            </div>
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
  /* No `scroll-behavior: smooth` — we want programmatic scrolls to be
     instant so the scroll listener doesn't see intermediate positions
     of an animated scroll and briefly pick the wrong card as the
     centred one. */
}

/* End spacers so every card — including the very first (Overview) and
   the very last day — can actually be scrolled to the viewport centre.
   Half-card width + a bit of breathing room. */
.trip-timeline::before,
.trip-timeline::after {
  content: '';
  flex: 0 0 calc(50% - 45px);
  pointer-events: none;
}

@media (max-width: 768px) {
  .trip-timeline::before,
  .trip-timeline::after {
    flex: 0 0 calc(50% - 38px);
  }
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

/* First stop of a day: ring the cover in the day's colour so day
   boundaries stay readable in the continuous, always-expanded sequence. */
.trip-timeline-item--day-first .trip-timeline-thumb {
  border-color: var(--day-color, var(--p-content-border-color, #dee2e6));
}

/* Selection wins over the day-colour ring (declared afterwards, equal
   specificity). */
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
