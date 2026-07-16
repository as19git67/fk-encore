<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { RecapMapIntroData } from '../utils/recapMapIntro'

/**
 * Animated intro slide for trip recaps: a non-interactive map that draws a
 * dashed route from home to the trip destination while the camera flies to
 * frame both, then drops a labelled destination marker. With no home
 * coordinates (older recaps) it falls back to a plain fly-in on the
 * destination.
 */
const props = defineProps<{
  intro: RecapMapIntroData
  durationMs: number
}>()

const container = ref<HTMLDivElement | null>(null)
let map: L.Map | null = null
let raf = 0
let flyTimer: ReturnType<typeof setTimeout> | null = null

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
    zoomAnimation: true,
  })
  L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map)

  const to = L.latLng(props.intro.to.lat, props.intro.to.lon)

  if (props.intro.from) {
    const from = L.latLng(props.intro.from.lat, props.intro.from.lon)
    map.setView(from, 8)

    // Home dot stays put; the route line + head dot grow towards the trip.
    L.circleMarker(from, {
      radius: 6,
      color: '#fff',
      weight: 2,
      fillColor: '#2563eb',
      fillOpacity: 1,
    }).addTo(map)
    const line = L.polyline([from, from], {
      color: '#fff',
      weight: 3,
      dashArray: '2 8',
      opacity: 0.95,
    }).addTo(map)
    const head = L.circleMarker(from, {
      radius: 5,
      color: '#fff',
      fillColor: '#fff',
      fillOpacity: 1,
      weight: 1,
    }).addTo(map)

    const bounds = L.latLngBounds([from, to]).pad(0.3)
    const lineDurationMs = props.durationMs * 0.65
    flyTimer = setTimeout(() => {
      map?.flyToBounds(bounds, { duration: lineDurationMs / 1000 })
    }, 300)

    const start = performance.now()
    const step = (now: number) => {
      if (!map) return
      const t = Math.min(1, (now - start) / lineDurationMs)
      const e = easeInOut(t)
      const cur = L.latLng(
        from.lat + (to.lat - from.lat) * e,
        from.lng + (to.lng - from.lng) * e
      )
      line.setLatLngs([from, cur])
      head.setLatLng(cur)
      if (t < 1) {
        raf = requestAnimationFrame(step)
      } else {
        head.remove()
        destinationMarker(to).addTo(map)
      }
    }
    raf = requestAnimationFrame(step)
  } else {
    // No home known — zoom from a wide view onto the destination.
    map.setView(to, 4)
    destinationMarker(to).addTo(map)
    flyTimer = setTimeout(() => {
      map?.flyTo(to, 10, { duration: (props.durationMs * 0.6) / 1000 })
    }, 300)
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (flyTimer) clearTimeout(flyTimer)
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
