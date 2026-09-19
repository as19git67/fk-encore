<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * The only place wide content may scroll sideways (issue #1272, stage 1).
 *
 * The page itself never scrolls horizontally (`overflow-x: clip` on body),
 * so a table, a code block or an image strip that is wider than the screen
 * goes inside this wrapper. It scrolls on its own, is reachable by keyboard
 * and fades its edges while there is more to see in that direction.
 */

const el = ref<HTMLElement | null>(null)
const atStart = ref(true)
const atEnd = ref(true)

function update() {
  const node = el.value
  if (!node) return
  atStart.value = node.scrollLeft <= 1
  atEnd.value = Math.ceil(node.scrollLeft + node.clientWidth) >= node.scrollWidth - 1
}

let observer: ResizeObserver | null = null
onMounted(() => {
  update()
  if (typeof ResizeObserver !== 'undefined' && el.value) {
    observer = new ResizeObserver(update)
    observer.observe(el.value)
    // Content inside grows after mount (a table filling from a request).
    for (const child of Array.from(el.value.children)) observer.observe(child)
  }
})
onBeforeUnmount(() => observer?.disconnect())

defineExpose({ el, update })
</script>

<template>
  <div
    ref="el"
    class="scroll-x"
    :class="{ 'scroll-x--more-start': !atStart, 'scroll-x--more-end': !atEnd }"
    tabindex="0"
    @scroll.passive="update"
  >
    <slot />
  </div>
</template>

<style scoped>
.scroll-x {
  overflow-x: auto;
  overflow-y: hidden;
  max-width: 100%;
  min-width: 0;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
}
.scroll-x:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}
/* Edge fades: a hint that the row continues, without a second scrollbar. */
.scroll-x--more-start {
  mask-image: linear-gradient(to right, transparent, black 24px);
}
.scroll-x--more-end {
  mask-image: linear-gradient(to left, transparent, black 24px);
}
.scroll-x--more-start.scroll-x--more-end {
  mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent);
}
</style>
