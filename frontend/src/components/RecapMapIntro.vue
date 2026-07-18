<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { RecapMapIntroData } from '../utils/recapMapIntro'

/**
 * Animated intro slide for trip recaps: a non-interactive map that renders at
 * its final bounds immediately (no fly/zoom animation) and draws a dashed
 * route line from home to the trip destination. The animation only starts
 * once all visible tiles have loaded so there are no grey placeholders.
 */
const props = defineProps<{
  intro: RecapMapIntroData
  durationMs: number
}>()

const emit = defineEmits<{ ready: [] }>()

const container = ref<HTMLDivElement | null>(null)
let map: L.Map | null = null
let raf = 0
let animTimer: ReturnType<typeof setTimeout> | null = null

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (1 - t) * (2 - 2 * t)
}

function destinationMarker(at: L.LatLng): L.Layer {
  const marker = L.circleMarker(at, {
    radius: 8,
    color: '#fff',
    weight: 2,
    fillColor: '#e11d48',
    fillOpacity: 1,
  })
  if (props.intro.label) {
    marker.bindTooltip(props.intro.label, {
      permanent: true,
      direction: 'top',
      offset: L.point(0, -10),
      className: 'recap-map-label',
    })
  }
  return marker
}

function startLineAnimation(
  m: L.Map,
  from: L.LatLng,
  to: L.LatLng,
): void {
  L.circleMarker(from, {
    radius: 6,
    color: '#fff',
    weight: 2,
    fillColor: '#2563eb',
    fillOpacity: 1,
  }).addTo(m)

  const line = L.polyline([from, from], {
    color: '#fff',
    weight: 3,
    dashArray: '2 8',
    opacity: 0.95,
  }).addTo(m)

  const head = L.circleMarker(from, {
    radius: 5,
    color: '#fff',
    fillColor: '#fff',
    fillOpacity: 1,
    weight: 1,
  }).addTo(m)

  const lineDurationMs = props.durationMs * 0.7
  const start = performance.now()
  const step = (now: number) => {
    if (!map) return
    const t = Math.min(1, (now - start) / lineDurationMs)
    const e = easeInOut(t)
    const cur = L.latLng(
      from.lat + (to.lat - from.lat) * e,
      from.lng + (to.lng - from.lng) * e,
    )
    line.setLatLngs([from, cur])
    head.setLatLng(cur)
    if (t < 1) {
      raf = requestAnimationFrame(step)
    } else {
      head.remove()
      destinationMarker(to).addTo(m)
    }
  }
  raf = requestAnimationFrame(step)
}

onMounted(() => {
  if (!container.value) return
  map = L.map(container.value, {
    zoomControl: false,
    attributionControl: true,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    zoomAnimation: false,
  })

  const tileLayer = L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    noWrap: true,
  }).addTo(map)
  map.setMaxBounds([[-85, -180], [85, 180]])

  const to = L.latLng(props.intro.to.lat, props.intro.to.lon)

  // Set the final view immediately — no fly animation.
  if (props.intro.from) {
    const from = L.latLng(props.intro.from.lat, props.intro.from.lon)
    const bounds = L.latLngBounds([from, to]).pad(0.3)
    map.fitBounds(bounds, { animate: false })
  } else {
    map.setView(to, 10)
  }

  // Wait for all visible tiles to load before starting the animation.
  const onTilesReady = () => {
    emit('ready')
    if (!map) return

    if (props.intro.from) {
      const from = L.latLng(props.intro.from.lat, props.intro.from.lon)
      startLineAnimation(map, from, to)
    } else {
      destinationMarker(to).addTo(map)
    }
  }

  // Leaflet fires 'load' on the tile layer when all visible tiles finish.
  // Guard with a timeout in case tiles are cached and 'load' already fired.
  let tilesReady = false
  const handleLoad = () => {
    if (tilesReady) return
    tilesReady = true
    tileLayer.off('load', handleLoad)
    onTilesReady()
  }
  tileLayer.on('load', handleLoad)

  // Fallback: if tiles arrive instantly (cached) or something goes wrong,
  // start after a short timeout so the show isn't stuck indefinitely.
  animTimer = setTimeout(() => {
    handleLoad()
  }, 3000)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (animTimer) clearTimeout(animTimer)
  map?.remove()
  map = null
})
</script>

<template>
  <div ref="container" class="recap-map-intro" />
</template>

<style scoped>
.recap-map-intro {
  position: absolute;
  inset: 0;
  background: #000;
}

/* The player is dark; tone the light map tiles down a little. */
.recap-map-intro :deep(.leaflet-tile-pane) {
  filter: brightness(0.82) saturate(0.9);
}

.recap-map-intro :deep(.recap-map-label) {
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 0.95rem;
  font-weight: 600;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}

.recap-map-intro :deep(.recap-map-label::before) {
  display: none;
}
</style>
