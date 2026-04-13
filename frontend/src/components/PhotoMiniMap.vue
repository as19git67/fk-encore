<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const props = defineProps<{
  latitude: number
  longitude: number
  /** Optional location label shown as marker popup/title */
  label?: string
}>()

const mapContainer = ref<HTMLElement | null>(null)
let map: L.Map | null = null
let marker: L.Marker | null = null

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
    zoomControl: false,
    attributionControl: false,
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
    marker = L.marker([props.latitude, props.longitude], { icon: buildIcon() }).addTo(map)
  }
  if (props.label) marker.bindTooltip(props.label, { direction: 'top', offset: [0, -24] })
  map.setView([props.latitude, props.longitude], 14)
}

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
  <div ref="mapContainer" class="photo-mini-map" />
</template>

<style scoped>
.photo-mini-map {
  width: 100%;
  height: 140px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--p-content-border-color, #dee2e6);
  background: var(--p-content-hover-background);
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
