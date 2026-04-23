<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HeicImage from './HeicImage.vue'
import { getPhotoUrl, type Photo } from '../api/photos'

const props = defineProps<{
  photos: Photo[]
  title?: string
  subtitle?: string | null
  open: boolean
  durationMs?: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const photoDurationMs = computed(() => props.durationMs ?? 4500)

const index = ref(0)
const paused = ref(false)
const showControls = ref(true)

let advanceTimer: ReturnType<typeof setTimeout> | null = null
let controlsTimer: ReturnType<typeof setTimeout> | null = null
let advanceToken = 0

const preloadCache = new Map<string, Promise<boolean>>()
const PRELOAD_WAIT_TIMEOUT_MS = 5000

const current = computed(() => props.photos[index.value] ?? null)
const total = computed(() => props.photos.length)

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

const motion = computed<Motion>(() => pickMotion(current.value?.id ?? index.value + 1))

const animStyle = computed(() => {
  const m = motion.value
  return {
    '--kb-from-scale': String(m.fromScale),
    '--kb-to-scale': String(m.toScale),
    '--kb-from-x': `${m.fromX}%`,
    '--kb-from-y': `${m.fromY}%`,
    '--kb-to-x': `${m.toX}%`,
    '--kb-to-y': `${m.toY}%`,
    '--kb-duration': `${photoDurationMs.value}ms`,
  } as Record<string, string>
})

function clearAdvance() {
  if (advanceTimer) {
    clearTimeout(advanceTimer)
    advanceTimer = null
  }
  advanceToken++
}

function photoDisplayUrl(photo: Photo): string {
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

function preloadOffset(offset: number) {
  const idx = index.value + offset
  if (idx < 0 || idx >= total.value) return
  const photo = props.photos[idx]
  if (!photo) return
  void preloadUrl(photoDisplayUrl(photo))
}

function waitForOffset(offset: number): Promise<void> {
  const idx = index.value + offset
  if (idx < 0 || idx >= total.value) return Promise.resolve()
  const photo = props.photos[idx]
  if (!photo) return Promise.resolve()
  const preload = preloadUrl(photoDisplayUrl(photo))
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), PRELOAD_WAIT_TIMEOUT_MS)
    preload.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function scheduleAdvance() {
  clearAdvance()
  if (paused.value || !props.open || total.value === 0) return
  preloadOffset(1)
  const token = ++advanceToken
  advanceTimer = setTimeout(async () => {
    advanceTimer = null
    await waitForOffset(1)
    if (token !== advanceToken) return
    if (!props.open || paused.value) return
    next()
  }, photoDurationMs.value)
}

function next() {
  if (total.value === 0) return
  if (index.value >= total.value - 1) {
    emit('close')
    return
  }
  index.value += 1
  scheduleAdvance()
}

function prev() {
  if (total.value === 0) return
  index.value = Math.max(0, index.value - 1)
  scheduleAdvance()
}

function togglePause() {
  paused.value = !paused.value
  if (paused.value) clearAdvance()
  else scheduleAdvance()
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
  }
}

function bumpControls() {
  showControls.value = true
  if (controlsTimer) clearTimeout(controlsTimer)
  controlsTimer = setTimeout(() => {
    showControls.value = false
  }, 2500)
}

function reset() {
  index.value = 0
  paused.value = false
  bumpControls()
  scheduleAdvance()
}

watch(() => props.open, (isOpen) => {
  if (isOpen) reset()
  else clearAdvance()
})

watch(() => props.photos, () => {
  preloadCache.clear()
  if (props.open) reset()
})

onMounted(() => {
  window.addEventListener('keydown', handleKey)
  if (props.open) reset()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKey)
  clearAdvance()
  if (controlsTimer) clearTimeout(controlsTimer)
})
</script>

<template>
  <div
    v-if="open"
    class="recap-player"
    @mousemove="bumpControls"
    @touchstart="bumpControls"
  >
    <div class="recap-player-stage">
      <transition name="kb-fade" mode="out-in">
        <div
          v-if="current"
          :key="current.id"
          class="kb-slide"
          :style="animStyle"
        >
          <HeicImage
            :src="getPhotoUrl(current.filename, 1600)"
            :alt="current.original_name"
            object-fit="cover"
          />
        </div>
      </transition>
    </div>

    <div class="recap-player-title" :class="{ 'is-hidden': !showControls && index > 0 }">
      <div v-if="title" class="recap-player-title-text">{{ title }}</div>
      <div v-if="subtitle" class="recap-player-subtitle">{{ subtitle }}</div>
    </div>

    <div class="recap-player-progress">
      <div
        v-for="(_p, i) in photos"
        :key="i"
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
}

.recap-player-stage {
  position: absolute;
  inset: 0;
}

.kb-slide {
  position: absolute;
  inset: 0;
  animation: ken-burns var(--kb-duration, 4500ms) linear forwards;
  will-change: transform;
}

.kb-slide :deep(img),
.kb-slide :deep(.heic-image-container) {
  width: 100%;
  height: 100%;
  object-fit: cover;
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

.kb-fade-enter-active,
.kb-fade-leave-active {
  transition: opacity 600ms ease;
}
.kb-fade-enter-from,
.kb-fade-leave-to {
  opacity: 0;
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
