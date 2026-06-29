<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getPhotoUrl } from '../api/photos'
import { feedPinchZoom, isFeedFullscreenTap } from '../utils/feedFullscreen'

const props = defineProps<{
  filename: string
  alt?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const overlayRef = ref<HTMLElement | null>(null)
const zoom = ref(1)
const panX = ref(0)
const panY = ref(0)
const transformStyle = computed(() => ({
  transform: `translate3d(${panX.value}px, ${panY.value}px, 0) scale(${zoom.value})`,
}))

let touchStartX = 0
let touchStartY = 0
let panStartX = 0
let panStartY = 0
let pinchStartDistance = 0
let pinchStartZoom = 1
let pinchStartPanX = 0
let pinchStartPanY = 0
let pinchStartMidX = 0
let pinchStartMidY = 0
let elementCenterX = 0
let elementCenterY = 0
let pinched = false
let moved = false
let closing = false
let previousBodyOverflow = ''
let suppressClickUntil = 0

function distance(a: Touch, b: Touch): number {
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
}

function midpoint(a: Touch, b: Touch): { x: number; y: number } {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
}

function onTouchStart(event: TouchEvent) {
  if (event.touches.length === 1) {
    const touch = event.touches[0]!
    touchStartX = touch.clientX
    touchStartY = touch.clientY
    panStartX = panX.value
    panStartY = panY.value
    moved = false
    pinched = false
  } else if (event.touches.length === 2) {
    const first = event.touches[0]!
    const second = event.touches[1]!
    const mid = midpoint(first, second)
    const rect = overlayRef.value?.getBoundingClientRect()
    pinchStartDistance = distance(first, second)
    pinchStartZoom = zoom.value
    pinchStartPanX = panX.value
    pinchStartPanY = panY.value
    pinchStartMidX = mid.x
    pinchStartMidY = mid.y
    elementCenterX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
    elementCenterY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
    pinched = true
    moved = true
  }
}

function onTouchMove(event: TouchEvent) {
  event.preventDefault()
  if (event.touches.length === 2) {
    const first = event.touches[0]!
    const second = event.touches[1]!
    const mid = midpoint(first, second)
    const nextZoom = feedPinchZoom(pinchStartZoom, pinchStartDistance, distance(first, second))
    const localX = (pinchStartMidX - elementCenterX - pinchStartPanX) / pinchStartZoom
    const localY = (pinchStartMidY - elementCenterY - pinchStartPanY) / pinchStartZoom
    zoom.value = nextZoom
    panX.value = mid.x - elementCenterX - localX * nextZoom
    panY.value = mid.y - elementCenterY - localY * nextZoom
    pinched = true
    moved = true
  } else if (event.touches.length === 1 && zoom.value > 1) {
    const touch = event.touches[0]!
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    panX.value = panStartX + dx
    panY.value = panStartY + dy
    if (Math.hypot(dx, dy) >= 10) moved = true
  }
}

function onTouchEnd(event: TouchEvent) {
  if (event.touches.length > 0 || event.changedTouches.length === 0) return
  const touch = event.changedTouches[0]!
  const dx = touch.clientX - touchStartX
  const dy = touch.clientY - touchStartY
  if (moved || pinched) {
    suppressClickUntil = Date.now() + 500
    return
  }
  if (isFeedFullscreenTap(dx, dy, pinched)) void close()
}

function onTouchCancel() {
  moved = true
  suppressClickUntil = Date.now() + 500
}

function onContentClick() {
  if (Date.now() < suppressClickUntil) return
  void close()
}

function close() {
  if (closing) return
  closing = true
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' && event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.stopImmediatePropagation()
  close()
}

onMounted(() => {
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', onKeydown, true)
})

onUnmounted(() => {
  document.body.style.overflow = previousBodyOverflow
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="overlayRef"
      class="feed-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label="Foto im Vollbild"
      @click.self="close"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchCancel"
    >
      <div class="feed-fullscreen__zoom" :style="transformStyle" @click="onContentClick">
        <img
          :src="getPhotoUrl(filename, 2560)"
          :alt="alt ?? filename"
          draggable="false"
        />
      </div>
      <button class="feed-fullscreen__close" type="button" aria-label="Vollbild schließen" @click.stop="close">
        <i class="pi pi-times" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.feed-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1400;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #000;
  touch-action: none;
  user-select: none;
}

.feed-fullscreen__zoom {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  transform-origin: center;
  will-change: transform;
}

.feed-fullscreen__zoom img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  -webkit-user-drag: none;
}

.feed-fullscreen__close {
  position: fixed;
  top: max(0.75rem, env(safe-area-inset-top));
  right: max(0.75rem, env(safe-area-inset-right));
  width: 2.75rem;
  height: 2.75rem;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  color: #fff;
  background: rgb(0 0 0 / 45%);
  font-size: 1.25rem;
  cursor: pointer;
}
</style>
