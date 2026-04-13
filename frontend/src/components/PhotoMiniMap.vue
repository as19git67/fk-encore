<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted, nextTick } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const props = defineProps<{
  latitude: number
  longitude: number
  /** Optional location label used as marker tooltip / map-link query */
  label?: string
}>()

const mapContainer = ref<HTMLElement | null>(null)
let map: L.Map | null = null
let marker: L.Marker | null = null

const DEFAULT_ZOOM = 16

function buildIcon(): L.DivIcon {
  return L.divIcon({
    className: 'photo-mini-pin-icon',
    iconSize: [22, 28],
    iconAnchor: [11, 28],
    html: `<div class="photo-mini-pin"><div class="photo-mini-pin-dot"></div><div class="photo-mini-pin-tail"></div></div>`,
  })
}

function initMap() {
  if (!mapContainer.value || map) return
  map = L.map(mapContainer.value, {
    // We render our own +/- buttons as an overlay so they can sit above
    // the optional map-link anchor.
    zoomControl: false,
    attributionControl: false,
    // Keep the map mostly static: no drag, no wheel / touch zoom. Only
    // the +/- buttons change the zoom level.
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
  })

  L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
  updateMarker()
}

function updateMarker() {
  if (!map) return
  if (marker) {
    marker.setLatLng([props.latitude, props.longitude])
  } else {
    marker = L.marker([props.latitude, props.longitude], {
      icon: buildIcon(),
      // Keep the marker non-interactive so clicks pass through to the
      // overlay link behind it.
      interactive: false,
    }).addTo(map)
  }
  if (props.label) marker.bindTooltip(props.label, { direction: 'top', offset: [0, -24] })
  map.setView([props.latitude, props.longitude], DEFAULT_ZOOM)
}

function zoomIn() {
  if (!map) return
  map.setZoom(Math.min(map.getZoom() + 1, 19))
}

function zoomOut() {
  if (!map) return
  map.setZoom(Math.max(map.getZoom() - 1, 2))
}

// ── External map link (Apple Maps on Apple devices, Google Maps elsewhere) ─
const isApple = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Mac/.test(navigator.userAgent)
const mapLink = computed(() => {
  const { latitude: lat, longitude: lng, label } = props
  if (isApple) {
    const q = label || `${lat},${lng}`
    return `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(q)}`
  }
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
})

onMounted(async () => {
  await nextTick()
  initMap()
})

onUnmounted(() => {
  if (map) { map.remove(); map = null }
  marker = null
})

watch(() => [props.latitude, props.longitude], () => {
  if (!map) return
  updateMarker()
  // Leaflet needs a size-invalidation if the container was just unhidden/resized
  nextTick(() => map?.invalidateSize())
})
</script>

<template>
  <div class="photo-mini-map-wrap">
    <div ref="mapContainer" class="photo-mini-map" />

    <!-- Clickable overlay that opens the location in the platform map app.
         Sits between the tile layer and the zoom controls so the +/-
         buttons still work, while a click anywhere else on the map opens
         the external map. -->
    <a
      class="photo-mini-map-link"
      :href="mapLink"
      target="_blank"
      rel="noopener"
      v-tooltip.top="isApple ? 'In Apple Karten öffnen' : 'In Google Maps öffnen'"
      aria-label="Karte in externer App öffnen"
    />

    <div class="photo-mini-map-zoom">
      <button type="button" class="photo-mini-map-zoom-btn" @click.stop.prevent="zoomIn" aria-label="Zoom in">+</button>
      <button type="button" class="photo-mini-map-zoom-btn" @click.stop.prevent="zoomOut" aria-label="Zoom out">−</button>
    </div>
  </div>
</template>

<style scoped>
.photo-mini-map-wrap {
  position: relative;
  width: 100%;
  height: 160px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--p-content-border-color, #dee2e6);
  background: var(--p-content-hover-background);
}

.photo-mini-map {
  position: absolute;
  inset: 0;
}

/* Full-surface anchor that opens the external map app.
   Sits above Leaflet's marker pane (z-index 600) so clicks don't get
   swallowed by the pin, but below the zoom controls. */
.photo-mini-map-link {
  position: absolute;
  inset: 0;
  z-index: 650;
  cursor: pointer;
  text-decoration: none;
}

.photo-mini-map-zoom {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 700; /* above the map link anchor */
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.photo-mini-map-zoom-btn {
  width: 26px;
  height: 26px;
  border: 1px solid var(--p-content-border-color, #ccc);
  background: var(--p-content-background, #fff);
  color: var(--p-text-color, #222);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1;
  border-radius: 4px;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.photo-mini-map-zoom-btn:hover {
  background: var(--p-content-hover-background, #f4f4f4);
}

.photo-mini-map-zoom-btn:active {
  transform: translateY(1px);
}
</style>

<style>
.photo-mini-pin-icon {
  background: none !important;
  border: none !important;
}

.photo-mini-pin {
  position: relative;
  width: 22px;
  height: 28px;
}

.photo-mini-pin-dot {
  position: absolute;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--p-primary-color, #4285F4);
  border: 2px solid white;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}

.photo-mini-pin-tail {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 7px solid white;
}
</style>
