<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HeicImage from './HeicImage.vue'
import RecapMapIntro from './RecapMapIntro.vue'
import type { RecapMapIntroData } from '../utils/recapMapIntro'
import type { RecapCompareData } from '../utils/recapCompare'
import { collageObjectPosition } from '../utils/collageLayouts'
import {
  getPhotoUrl,
  updatePhotoCuration,
  type CurationStatus,
  type Photo,
} from '../api/photos'
import { getRenderedPhotoUrl } from '../api/photoTransforms'
import { useTransformedPhotosIndex } from '../composables/useTransformedPhotosIndex'
import { useAuthStore } from '../stores/auth'

const props = defineProps<{
  photos: Photo[]
  title?: string
  subtitle?: string | null
  open: boolean
  durationMs?: number
  /** Absolute URL of the background track; omit for a silent recap. */
  musicUrl?: string | null
  /** Trip map intro rendered as the first slide; omit to start with photos. */
  mapIntro?: RecapMapIntroData | null
  /** "Damals & heute" split-screen rendered as the first slide of person recaps. */
  compareIntro?: RecapCompareData | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const photoDurationMs = computed(() => props.durationMs ?? 4500)
// Collages carry 2–3 photos, so they stay on screen a bit longer.
const COLLAGE_DURATION_FACTOR = 1.4

const index = ref(0)
const paused = ref(false)
const showControls = ref(true)

// ── Slide plan ───────────────────────────────────────────────────────────────
// A slide is either a single Ken-Burns photo or a 2–3 photo collage whose
// tiles slide in from different edges. Collages are only formed "wenn es
// passt": the grouped photos must be taken close together in time, and two
// collages never follow each other back-to-back. The plan is deterministic
// (seeded by the photo ids), so replaying a recap yields the same sequence.

type SlideLayout = 'single' | 'duo' | 'trio' | 'map' | 'compare'

interface Slide {
  key: string
  layout: SlideLayout
  photos: Photo[]
}

const COLLAGE_MAX_TIME_GAP_MS = 6 * 60 * 60 * 1000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function photoTime(p: Photo): number | null {
  const iso = p.taken_at ?? p.created_at
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function closeInTime(a: Photo, b: Photo): boolean {
  const ta = photoTime(a)
  const tb = photoTime(b)
  if (ta == null || tb == null) return false
  return Math.abs(ta - tb) <= COLLAGE_MAX_TIME_GAP_MS
}

function buildSlides(photos: Photo[]): Slide[] {
  const out: Slide[] = []
  const rnd = mulberry32((photos[0]?.id ?? 1) * 2654435761 + photos.length)
  let i = 0
  let sinceCollage = 99
  while (i < photos.length) {
    const remaining = photos.length - i
    let size = 1
    const a = photos[i]
    const b = photos[i + 1]
    const c = photos[i + 2]
    if (remaining >= 2 && sinceCollage >= 2 && a && b) {
      const duoFits = closeInTime(a, b)
      const trioFits = remaining >= 3 && duoFits && !!c && closeInTime(b, c)
      const roll = rnd()
      if (trioFits && roll < 0.3) size = 3
      else if (duoFits && roll < 0.55) size = 2
    }
    const group = photos.slice(i, i + size)
    out.push({
      key: group.map((p) => p.id).join('-'),
      layout: size === 3 ? 'trio' : size === 2 ? 'duo' : 'single',
      photos: group,
    })
    sinceCollage = size > 1 ? 0 : sinceCollage + 1
    i += size
  }
  return out
}

const MAP_INTRO_DURATION_MS = 5500

const slides = computed<Slide[]>(() => {
  const plan = buildSlides(props.photos)
  if (props.compareIntro) {
    plan.unshift({
      key: 'compare-intro',
      layout: 'compare',
      photos: [props.compareIntro.then, props.compareIntro.now],
    })
  }
  if (props.mapIntro) {
    plan.unshift({ key: 'map-intro', layout: 'map', photos: [] })
  }
  return plan
})
const total = computed(() => slides.value.length)

function slideDurationMs(slide: Slide | null): number {
  if (!slide) return photoDurationMs.value
  if (slide.layout === 'map') return MAP_INTRO_DURATION_MS
  return slide.layout === 'single'
    ? photoDurationMs.value
    : Math.round(photoDurationMs.value * COLLAGE_DURATION_FACTOR)
}

const currentSlide = computed<Slide | null>(() => slides.value[index.value] ?? null)
const currentDurationMs = computed(() => slideDurationMs(currentSlide.value))

/** First photo of a slide — every slide carries at least one by construction. */
function primaryPhoto(slide: Slide): Photo {
  return slide.photos[0] as Photo
}

const slotA = ref<Slide | null>(null)
const slotB = ref<Slide | null>(null)
const activeSlot = ref<'A' | 'B'>('A')

let advanceTimer: ReturnType<typeof setTimeout> | null = null
let controlsTimer: ReturnType<typeof setTimeout> | null = null
let advanceToken = 0
const mapReady = ref(false)
let mapReadyResolve: (() => void) | null = null

const preloadCache = new Map<string, Promise<boolean>>()
const PRELOAD_WAIT_TIMEOUT_MS = 5000

// ── Ken Burns (single slides) ────────────────────────────────────────────────

type Motion = {
  fromScale: number
  toScale: number
  fromX: number
  fromY: number
  toX: number
  toY: number
}

function pickMotion(seed: number): Motion {
  const r = (x: number) => {
    const s = Math.sin(seed * 9301 + x * 49297) * 233280
    return s - Math.floor(s)
  }
  const zoomIn = r(1) > 0.5
  const fromScale = zoomIn ? 1.0 : 1.15
  const toScale = zoomIn ? 1.15 : 1.0
  const amp = 3
  const fromX = (r(2) - 0.5) * amp
  const fromY = (r(3) - 0.5) * amp
  const toX = (r(4) - 0.5) * amp
  const toY = (r(5) - 0.5) * amp
  return { fromScale, toScale, fromX, fromY, toX, toY }
}

function animStyleFor(slide: Slide | null): Record<string, string> {
  if (!slide || slide.layout !== 'single') return {}
  const photo = slide.photos[0]
  if (!photo) return {}
  const m = pickMotion(photo.id)
  return {
    '--kb-from-scale': String(m.fromScale),
    '--kb-to-scale': String(m.toScale),
    '--kb-from-x': `${m.fromX}%`,
    '--kb-from-y': `${m.fromY}%`,
    '--kb-to-x': `${m.toX}%`,
    '--kb-to-y': `${m.toY}%`,
    '--kb-duration': `${slideDurationMs(slide)}ms`,
    // Smart crop: keep the server-computed focal point (face centre) in
    // view under object-fit: cover instead of the geometric centre.
    '--kb-object-position': collageObjectPosition(photo.auto_crop ?? null),
  }
}

const slotAAnimStyle = computed(() => animStyleFor(slotA.value))
const slotBAnimStyle = computed(() => animStyleFor(slotB.value))

// Collage tiles enter from different edges; per-tile custom props drive the
// slide-in offset and a small stagger.
const COLLAGE_ENTRIES: Record<'duo' | 'trio', Array<{ x: string; y: string }>> = {
  duo: [
    { x: '-110%', y: '0%' },
    { x: '110%', y: '0%' },
  ],
  trio: [
    { x: '-110%', y: '0%' },
    { x: '110%', y: '-40%' },
    { x: '110%', y: '110%' },
  ],
}

/** Label chip for the "Damals & heute" compare slide (tile 0 = then). */
function compareLabel(tileIdx: number): string {
  const c = props.compareIntro
  if (!c) return ''
  return tileIdx === 0 ? `Damals · ${c.thenYear}` : `Heute · ${c.nowYear}`
}

function collageTileStyle(slide: Slide, tileIdx: number): Record<string, string> {
  const layout = slide.layout === 'trio' ? 'trio' : 'duo'
  const entry = COLLAGE_ENTRIES[layout][tileIdx] ?? { x: '0%', y: '110%' }
  // Alternate the slow inner zoom direction per tile for a lively collage.
  const zoomIn = (slide.photos[tileIdx]?.id ?? tileIdx) % 2 === 0
  return {
    '--tile-from-x': entry.x,
    '--tile-from-y': entry.y,
    '--tile-delay': `${tileIdx * 160}ms`,
    '--tile-zoom-from': zoomIn ? '1' : '1.12',
    '--tile-zoom-to': zoomIn ? '1.12' : '1',
    '--kb-duration': `${slideDurationMs(slide)}ms`,
    // Smart crop per tile — collages crop aggressively, so centring on the
    // focal point matters even more than on full-screen slides.
    '--tile-object-position': collageObjectPosition(
      slide.photos[tileIdx]?.auto_crop ?? null
    ),
  }
}

function clearAdvance() {
  if (advanceTimer) {
    clearTimeout(advanceTimer)
    advanceTimer = null
  }
  advanceToken++
}

function onMapReady() {
  mapReady.value = true
  mapReadyResolve?.()
  mapReadyResolve = null
}

function waitForMap(): Promise<void> {
  if (mapReady.value) return Promise.resolve()
  return new Promise((resolve) => { mapReadyResolve = resolve })
}

const auth = useAuthStore()
const transformedIndex = useTransformedPhotosIndex()

function photoDisplayUrl(photo: Photo): string {
  // If the user has a saved recipe on this photo, route through the
  // render endpoint so the recap slide shows their crop + colour.
  // The server-rendered output is always JPEG, so the HEIC-conversion
  // branch below isn't needed in that path.
  const uid = auth.user?.id
  if (uid && transformedIndex.has(photo.id)) {
    return getRenderedPhotoUrl(photo.id, { variant: 'user', userId: uid, width: 1600 })
  }
  const base = getPhotoUrl(photo.filename, 1600)
  const pathPart = (photo.filename.split('?')[0] ?? photo.filename).toLowerCase()
  const isHeic = pathPart.endsWith('.heic') || pathPart.endsWith('.heif')
  if (!isHeic) return base
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  if (isSafari) return base
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}convert=true`
}

function preloadUrl(url: string): Promise<boolean> {
  const cached = preloadCache.get(url)
  if (cached) return cached
  const promise = new Promise<boolean>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = url
  })
  preloadCache.set(url, promise)
  return promise
}

function preloadSlide(slide: Slide | undefined) {
  if (!slide) return
  for (const photo of slide.photos) void preloadUrl(photoDisplayUrl(photo))
}

function preloadOffset(offset: number) {
  preloadSlide(slides.value[index.value + offset])
}

function waitForOffset(offset: number): Promise<void> {
  const slide = slides.value[index.value + offset]
  if (!slide) return Promise.resolve()
  const preloads = slide.photos.map((p) => preloadUrl(photoDisplayUrl(p)))
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), PRELOAD_WAIT_TIMEOUT_MS)
    Promise.allSettled(preloads).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function scheduleAdvance() {
  clearAdvance()
  if (paused.value || !props.open || total.value === 0) return
  const token = ++advanceToken

  // For map slides, wait until all tiles are loaded before starting the timer.
  if (currentSlide.value?.layout === 'map') {
    await waitForMap()
    if (token !== advanceToken || !props.open || paused.value) return
  }

  preloadOffset(1)
  advanceTimer = setTimeout(async () => {
    advanceTimer = null
    await waitForOffset(1)
    if (token !== advanceToken) return
    if (!props.open || paused.value) return
    next()
  }, currentDurationMs.value)
}

function goToIndex(newIndex: number) {
  if (newIndex < 0 || newIndex >= total.value) return
  if (newIndex === index.value && slotA.value !== null) return
  const slide = slides.value[newIndex]
  if (!slide) return
  index.value = newIndex
  const target: 'A' | 'B' = activeSlot.value === 'A' ? 'B' : 'A'
  if (target === 'A') slotA.value = slide
  else slotB.value = slide
  void nextTick(() => {
    activeSlot.value = target
  })
}

function next() {
  if (total.value === 0) return
  if (index.value >= total.value - 1) {
    emit('close')
    return
  }
  goToIndex(index.value + 1)
  scheduleAdvance()
}

function prev() {
  if (total.value === 0) return
  if (index.value === 0) return
  goToIndex(index.value - 1)
  scheduleAdvance()
}

// ── Favorites ────────────────────────────────────────────────────────────────
// The heart toggles favorite on every photo of the current slide (one photo
// on single slides, 2–3 on collages). Local overrides shadow the props so we
// never mutate the parent's Photo objects; on API failure the override is
// rolled back.

const curationOverrides = ref(new Map<number, CurationStatus>())
const favoriteBusy = ref(false)

function effectiveCuration(photo: Photo): CurationStatus {
  return curationOverrides.value.get(photo.id) ?? photo.curation_status
}

const currentSlideFavorite = computed(() => {
  const slide = currentSlide.value
  if (!slide || slide.photos.length === 0) return false
  return slide.photos.every((p) => effectiveCuration(p) === 'favorite')
})

const favoriteToggleable = computed(
  () => (currentSlide.value?.photos.length ?? 0) > 0
)

async function toggleFavorite() {
  const slide = currentSlide.value
  if (!slide || slide.photos.length === 0 || favoriteBusy.value) return
  const target: CurationStatus = currentSlideFavorite.value ? 'visible' : 'favorite'
  const previous = slide.photos.map((p) => [p.id, effectiveCuration(p)] as const)
  for (const p of slide.photos) curationOverrides.value.set(p.id, target)
  favoriteBusy.value = true
  try {
    await Promise.all(slide.photos.map((p) => updatePhotoCuration(p.id, target)))
  } catch {
    for (const [id, status] of previous) curationOverrides.value.set(id, status)
  } finally {
    favoriteBusy.value = false
  }
}

// ── Background music ─────────────────────────────────────────────────────────
// One looping <audio> per player session, gently faded in/out. Autoplay can be
// blocked when the player opens outside a fresh user gesture (the recap data
// is fetched async before opening) — in that case the next interaction
// (mousemove/touch/click) retries once.

const MUSIC_VOLUME = 0.55
const musicMuted = ref(false)
const musicBlocked = ref(false)

let audio: HTMLAudioElement | null = null
let fadeTimer: ReturnType<typeof setInterval> | null = null

function fadeTo(target: number, ms: number, onDone?: () => void) {
  if (!audio) return
  if (fadeTimer) clearInterval(fadeTimer)
  const el = audio
  const startVol = el.volume
  const steps = Math.max(1, Math.round(ms / 50))
  let i = 0
  fadeTimer = setInterval(() => {
    i++
    el.volume = Math.min(1, Math.max(0, startVol + ((target - startVol) * i) / steps))
    if (i >= steps) {
      if (fadeTimer) clearInterval(fadeTimer)
      fadeTimer = null
      onDone?.()
    }
  }, 50)
}

function stopMusic(fadeMs = 500) {
  if (!audio) return
  const el = audio
  audio = null
  if (fadeMs > 0 && !el.paused) {
    if (fadeTimer) clearInterval(fadeTimer)
    fadeTimer = null
    const startVol = el.volume
    const steps = Math.max(1, Math.round(fadeMs / 50))
    let i = 0
    const timer = setInterval(() => {
      i++
      el.volume = Math.max(0, startVol * (1 - i / steps))
      if (i >= steps) {
        clearInterval(timer)
        el.pause()
        el.src = ''
      }
    }, 50)
  } else {
    el.pause()
    el.src = ''
  }
}

function startMusic() {
  stopMusic(0)
  musicBlocked.value = false
  if (!props.musicUrl) return
  const el = new Audio(props.musicUrl)
  el.loop = true
  el.volume = 0
  el.muted = musicMuted.value
  audio = el
  void el
    .play()
    .then(() => fadeTo(MUSIC_VOLUME, 1500))
    .catch(() => {
      // Autoplay blocked — retry on the next user interaction.
      musicBlocked.value = true
    })
}

function retryBlockedMusic() {
  if (!musicBlocked.value || !audio) return
  musicBlocked.value = false
  void audio
    .play()
    .then(() => fadeTo(MUSIC_VOLUME, 1500))
    .catch(() => {
      musicBlocked.value = true
    })
}

function toggleMusicMuted() {
  musicMuted.value = !musicMuted.value
  if (audio) audio.muted = musicMuted.value
  if (!musicMuted.value) retryBlockedMusic()
}

function togglePause() {
  paused.value = !paused.value
  if (paused.value) {
    clearAdvance()
    if (audio && !audio.paused) audio.pause()
  } else {
    scheduleAdvance()
    if (audio) {
      void audio.play().catch(() => {
        musicBlocked.value = true
      })
    }
  }
}

function handleKey(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    emit('close')
  } else if (e.key === 'ArrowRight') {
    next()
  } else if (e.key === 'ArrowLeft') {
    prev()
  } else if (e.key === ' ') {
    e.preventDefault()
    togglePause()
  } else if (e.key === 'f' || e.key === 'F') {
    void toggleFavorite()
  }
}

function bumpControls() {
  retryBlockedMusic()
  showControls.value = true
  if (controlsTimer) clearTimeout(controlsTimer)
  controlsTimer = setTimeout(() => {
    showControls.value = false
  }, 2500)
}

function reset() {
  index.value = 0
  paused.value = false
  activeSlot.value = 'A'
  slotA.value = slides.value[0] ?? null
  slotB.value = null
  mapReady.value = false
  mapReadyResolve = null
  bumpControls()
  scheduleAdvance()
}

// The player is teleported to <body>; lock the page scroll behind it so the
// fullscreen stage never scrolls the app shell underneath.
function setBodyScrollLock(locked: boolean) {
  document.body.style.overflow = locked ? 'hidden' : ''
}

watch(() => props.open, (isOpen) => {
  setBodyScrollLock(isOpen)
  if (isOpen) {
    reset()
    startMusic()
  } else {
    clearAdvance()
    stopMusic()
  }
})

watch(() => props.photos, () => {
  preloadCache.clear()
  curationOverrides.value.clear()
  if (props.open) reset()
})

watch(() => props.musicUrl, () => {
  if (props.open) startMusic()
})

onMounted(() => {
  window.addEventListener('keydown', handleKey)
  if (props.open) {
    setBodyScrollLock(true)
    reset()
    startMusic()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKey)
  clearAdvance()
  if (controlsTimer) clearTimeout(controlsTimer)
  stopMusic(0)
  if (fadeTimer) clearInterval(fadeTimer)
  setBodyScrollLock(false)
})
</script>

<template>
  <!-- Teleported to <body>: inside the router view the player would sit in the
       `.content` stacking context (z-index 0) and end up BELOW the sticky
       toolbar (z-index 1100), so it never covered the full screen. -->
  <Teleport to="body">
    <div
      v-if="open"
      class="recap-player"
      @mousemove="bumpControls"
      @touchstart="bumpControls"
    >
      <div class="recap-player-stage">
        <div class="kb-slide" :class="{ 'is-active': activeSlot === 'A' }">
          <RecapMapIntro
            v-if="slotA && slotA.layout === 'map' && mapIntro"
            :key="`A-${slotA.key}`"
            :intro="mapIntro"
            :duration-ms="MAP_INTRO_DURATION_MS"
            @ready="onMapReady"
          />
          <div
            v-else-if="slotA && slotA.layout === 'single'"
            :key="`A-${slotA.key}`"
            class="kb-motion"
            :style="slotAAnimStyle"
          >
            <HeicImage
              :src="photoDisplayUrl(primaryPhoto(slotA))"
              :alt="primaryPhoto(slotA).original_name"
              object-fit="cover"
            />
          </div>
          <div
            v-else-if="slotA"
            :key="`A-collage-${slotA.key}`"
            class="collage"
            :class="slotA.layout"
          >
            <div
              v-for="(photo, tileIdx) in slotA.photos"
              :key="photo.id"
              class="collage-tile"
              :style="collageTileStyle(slotA, tileIdx)"
            >
              <div class="collage-tile-zoom">
                <HeicImage
                  :src="photoDisplayUrl(photo)"
                  :alt="photo.original_name"
                  object-fit="cover"
                />
              </div>
              <span v-if="slotA.layout === 'compare'" class="compare-label">
                {{ compareLabel(tileIdx) }}
              </span>
            </div>
          </div>
        </div>
        <div class="kb-slide" :class="{ 'is-active': activeSlot === 'B' }">
          <RecapMapIntro
            v-if="slotB && slotB.layout === 'map' && mapIntro"
            :key="`B-${slotB.key}`"
            :intro="mapIntro"
            :duration-ms="MAP_INTRO_DURATION_MS"
            @ready="onMapReady"
          />
          <div
            v-else-if="slotB && slotB.layout === 'single'"
            :key="`B-${slotB.key}`"
            class="kb-motion"
            :style="slotBAnimStyle"
          >
            <HeicImage
              :src="photoDisplayUrl(primaryPhoto(slotB))"
              :alt="primaryPhoto(slotB).original_name"
              object-fit="cover"
            />
          </div>
          <div
            v-else-if="slotB"
            :key="`B-collage-${slotB.key}`"
            class="collage"
            :class="slotB.layout"
          >
            <div
              v-for="(photo, tileIdx) in slotB.photos"
              :key="photo.id"
              class="collage-tile"
              :style="collageTileStyle(slotB, tileIdx)"
            >
              <div class="collage-tile-zoom">
                <HeicImage
                  :src="photoDisplayUrl(photo)"
                  :alt="photo.original_name"
                  object-fit="cover"
                />
              </div>
              <span v-if="slotB.layout === 'compare'" class="compare-label">
                {{ compareLabel(tileIdx) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="recap-player-title" :class="{ 'is-hidden': !showControls && index > 0 }">
        <div v-if="title" class="recap-player-title-text">{{ title }}</div>
        <div v-if="subtitle" class="recap-player-subtitle">{{ subtitle }}</div>
      </div>

      <div
        class="recap-player-progress"
        :style="{ '--kb-duration': `${currentDurationMs}ms` }"
      >
        <div
          v-for="(s, i) in slides"
          :key="s.key"
          class="recap-player-progress-seg"
          :class="{
            'is-done': i < index,
            'is-active': i === index,
            'is-paused': i === index && paused,
          }"
        >
          <div class="recap-player-progress-fill" />
        </div>
      </div>

      <div class="recap-player-controls" :class="{ 'is-hidden': !showControls }">
        <button type="button" class="recap-player-btn" aria-label="Zurück" @click="prev">
          <i class="pi pi-chevron-left" />
        </button>
        <button
          type="button"
          class="recap-player-btn recap-player-btn-pause"
          :aria-label="paused ? 'Wiedergabe' : 'Pause'"
          @click="togglePause"
        >
          <i :class="paused ? 'pi pi-play' : 'pi pi-pause'" />
        </button>
        <button type="button" class="recap-player-btn" aria-label="Weiter" @click="next">
          <i class="pi pi-chevron-right" />
        </button>
        <button
          v-if="musicUrl"
          type="button"
          class="recap-player-btn"
          :aria-label="musicMuted ? 'Musik einschalten' : 'Musik stummschalten'"
          @click="toggleMusicMuted"
        >
          <i :class="musicMuted || musicBlocked ? 'pi pi-volume-off' : 'pi pi-volume-up'" />
        </button>
        <button
          v-if="favoriteToggleable"
          type="button"
          class="recap-player-btn recap-player-btn-heart"
          :class="{ 'is-favorite': currentSlideFavorite }"
          :aria-label="currentSlideFavorite ? 'Favorit entfernen' : 'Als Favorit markieren'"
          :disabled="favoriteBusy"
          @click="toggleFavorite"
        >
          <i :class="currentSlideFavorite ? 'pi pi-heart-fill' : 'pi pi-heart'" />
        </button>
      </div>

      <button
        type="button"
        class="recap-player-close"
        aria-label="Schließen"
        :class="{ 'is-hidden': !showControls }"
        @click="emit('close')"
      >
        <i class="pi pi-times" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.recap-player {
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: #000;
  color: #fff;
  overflow: hidden;
  user-select: none;
  touch-action: none;
}

.recap-player-stage {
  position: absolute;
  inset: 0;
}

.kb-slide {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 600ms ease;
  pointer-events: none;
}

.kb-slide.is-active {
  opacity: 1;
}

.kb-motion {
  position: absolute;
  inset: 0;
  animation: ken-burns var(--kb-duration, 4500ms) linear forwards;
  will-change: transform;
}

.kb-motion :deep(img),
.kb-motion :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: var(--kb-object-position, 50% 50%);
}

@keyframes ken-burns {
  from {
    transform: translate(var(--kb-from-x, 0%), var(--kb-from-y, 0%))
      scale(var(--kb-from-scale, 1));
  }
  to {
    transform: translate(var(--kb-to-x, 0%), var(--kb-to-y, 0%))
      scale(var(--kb-to-scale, 1.1));
  }
}

/* ── Collage slides ─────────────────────────────────────────────────────── */

.collage {
  position: absolute;
  inset: 0;
  display: grid;
  gap: 8px;
  padding: 8px;
}

.collage.duo,
.collage.compare {
  grid-template-columns: 1fr 1fr;
}

.collage.trio {
  grid-template-columns: 3fr 2fr;
  grid-template-rows: 1fr 1fr;
}

.collage.trio .collage-tile:first-child {
  grid-row: 1 / span 2;
}

/* Portrait screens: stack the collage vertically instead of side-by-side. */
@media (orientation: portrait) {
  .collage.duo,
  .collage.compare {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .collage.trio {
    grid-template-columns: 2fr 3fr;
    grid-template-rows: 1fr 1fr;
  }
  .collage.trio .collage-tile:first-child {
    grid-row: 1 / span 2;
    grid-column: 2;
  }
}

.collage-tile {
  position: relative;
  overflow: hidden;
  border-radius: 10px;
  transform: translate(var(--tile-from-x, 0%), var(--tile-from-y, 110%));
  animation: collage-slide-in 700ms cubic-bezier(0.22, 0.9, 0.35, 1) forwards;
  animation-delay: var(--tile-delay, 0ms);
  will-change: transform;
}

@keyframes collage-slide-in {
  to {
    transform: translate(0%, 0%);
  }
}

/* Slow inner zoom keeps collage tiles alive after they've slid in. */
.collage-tile-zoom {
  width: 100%;
  height: 100%;
  animation: collage-zoom var(--kb-duration, 6300ms) linear forwards;
  will-change: transform;
}

@keyframes collage-zoom {
  from {
    transform: scale(var(--tile-zoom-from, 1));
  }
  to {
    transform: scale(var(--tile-zoom-to, 1.12));
  }
}

.collage-tile :deep(img),
.collage-tile :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: var(--tile-object-position, 50% 50%);
}

.compare-label {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 0.95rem;
  font-weight: 600;
  white-space: nowrap;
  backdrop-filter: blur(4px);
}

.recap-player-title {
  position: absolute;
  top: 2rem;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  padding: 0 1rem;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.7);
  transition: opacity 0.4s ease;
  pointer-events: none;
  max-width: 90%;
}

.recap-player-title.is-hidden {
  opacity: 0;
}

.recap-player-title-text {
  font-size: 1.6rem;
  font-weight: 600;
}

.recap-player-subtitle {
  font-size: 0.95rem;
  opacity: 0.9;
  margin-top: 0.25rem;
}

.recap-player-progress {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  right: 0.75rem;
  display: flex;
  gap: 4px;
  pointer-events: none;
}

.recap-player-progress-seg {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.25);
  overflow: hidden;
}

.recap-player-progress-fill {
  height: 100%;
  background: rgba(255, 255, 255, 0.9);
  width: 0;
}

.recap-player-progress-seg.is-done .recap-player-progress-fill {
  width: 100%;
}

.recap-player-progress-seg.is-active .recap-player-progress-fill {
  width: 100%;
  animation: progress-fill var(--kb-duration, 4500ms) linear forwards;
}

.recap-player-progress-seg.is-active.is-paused .recap-player-progress-fill {
  animation-play-state: paused;
}

@keyframes progress-fill {
  from { width: 0; }
  to { width: 100%; }
}

.recap-player-controls {
  position: absolute;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 0.5rem;
  transition: opacity 0.4s ease;
}

.recap-player-controls.is-hidden {
  opacity: 0;
  pointer-events: none;
}

.recap-player-btn {
  width: 48px;
  height: 48px;
  border-radius: 999px;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  backdrop-filter: blur(4px);
}

.recap-player-btn:hover {
  background: rgba(0, 0, 0, 0.8);
}

.recap-player-btn-pause {
  width: 58px;
  height: 58px;
  font-size: 1.35rem;
}

.recap-player-btn-heart.is-favorite {
  color: #f43f5e;
}

.recap-player-btn-heart:disabled {
  cursor: progress;
  opacity: 0.7;
}

.recap-player-close {
  position: absolute;
  top: 1rem;
  right: 1rem;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  transition: opacity 0.4s ease;
}

.recap-player-close.is-hidden {
  opacity: 0;
  pointer-events: none;
}

.recap-player-close:hover {
  background: rgba(0, 0, 0, 0.85);
}
</style>
