<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import Menu from 'primevue/menu'
import { computeVisibleCount } from '../utils/toolbarOverflow'

/**
 * A single button inside the responsive toolbar.
 *
 * `label` is the text shown on the inline button (leave empty for an
 * icon-only button). `title` is used both for the hover tooltip *and* as the
 * label inside the overflow dropdown — so icon-only buttons still read
 * sensibly once they collapse into the menu.
 */
export interface ToolbarItem {
  key: string
  /** Inline button label. Empty string → icon-only inline button. */
  label?: string
  /** Tooltip text + label used in the overflow dropdown. */
  title: string
  icon: string
  severity?: string
  outlined?: boolean
  text?: boolean
  /** Extra class applied to the *inline* button only (e.g. test hooks). */
  itemClass?: string
  command: () => void
}

const props = defineProps<{
  items: ToolbarItem[]
}>()

const containerRef = ref<HTMLElement | null>(null)
const measureRef = ref<HTMLElement | null>(null)
const menuRef = ref<InstanceType<typeof Menu> | null>(null)

// How many of `props.items` are rendered inline. The rest spill into the
// overflow menu. Starts optimistic (all visible) and is corrected on mount.
const visibleCount = ref(props.items.length)

const visibleItems = computed(() => props.items.slice(0, visibleCount.value))
const overflowItems = computed(() => props.items.slice(visibleCount.value))

const moreLabel = 'Weitere Aktionen'

const menuModel = computed(() =>
  overflowItems.value.map((item) => ({
    label: item.title,
    icon: item.icon,
    command: () => item.command(),
  })),
)

function toggleMenu(event: Event) {
  menuRef.value?.toggle(event)
}

/**
 * Measure the (always-rendered, hidden) measurement row and decide how many
 * items fit inline. The last child of the measurement row is a sample of the
 * overflow toggle, so its width is reserved whenever something has to spill.
 */
function recompute() {
  const container = containerRef.value
  const measure = measureRef.value
  if (!container || !measure) return

  const children = Array.from(measure.children) as HTMLElement[]
  if (children.length <= 1) {
    visibleCount.value = props.items.length
    return
  }

  // Gap is read from the live computed style so it always matches the CSS.
  const styles = getComputedStyle(measure)
  const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0

  const overflowSample = children[children.length - 1]
  const overflowWidth = overflowSample ? overflowSample.offsetWidth : 0
  const itemWidths = children.slice(0, -1).map((el) => el.offsetWidth)

  visibleCount.value = computeVisibleCount(
    itemWidths,
    overflowWidth,
    container.clientWidth,
    gap,
  )
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  void nextTick(recompute)
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => recompute())
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// Recompute whenever the set of items (or their labels) changes — toggling a
// button's label, e.g. "Auswählen" ⇄ "Auswahl beenden", changes its width.
watch(
  () => props.items.map((i) => `${i.key}:${i.label ?? ''}`).join('|'),
  () => void nextTick(recompute),
)
</script>

<template>
  <div ref="containerRef" class="responsive-toolbar">
    <Button
      v-for="item in visibleItems"
      :key="item.key"
      :icon="item.icon"
      :label="item.label || undefined"
      size="small"
      :severity="item.severity"
      :outlined="item.outlined"
      :text="item.text"
      :class="['responsive-toolbar__item', item.itemClass]"
      v-tooltip.bottom="item.title"
      @click="item.command"
    />

    <Button
      v-if="overflowItems.length > 0"
      icon="pi pi-ellipsis-v"
      size="small"
      text
      class="responsive-toolbar__more"
      aria-haspopup="true"
      :aria-label="moreLabel"
      v-tooltip.bottom="moreLabel"
      @click="toggleMenu"
    />
    <Menu ref="menuRef" :model="menuModel" :popup="true" :pt="{ root: { class: 'selection-actions-menu' } }" />

    <!-- Hidden measurement row: always renders every item (plus a sample
         overflow toggle) at natural width so the visible row can be measured
         without a layout feedback loop. -->
    <div ref="measureRef" class="responsive-toolbar__measure" aria-hidden="true">
      <Button
        v-for="item in items"
        :key="`measure-${item.key}`"
        :icon="item.icon"
        :label="item.label || undefined"
        size="small"
        :outlined="item.outlined"
        :text="item.text"
        class="responsive-toolbar__item"
      />
      <Button icon="pi pi-ellipsis-v" size="small" text class="responsive-toolbar__more" />
    </div>
  </div>
</template>

<style scoped>
.responsive-toolbar {
  position: relative;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.5em;
  width: 100%;
  min-width: 0;
}

/* Push the overflow toggle to the far right so the inline items use the
   full available width. Minimum 44×44 px touch target (WCAG 2.5.5). */
.responsive-toolbar__more {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 2.75rem;
  min-height: 2.75rem;
}

.responsive-toolbar__item {
  flex-shrink: 0;
}

/* Off-layout measurement row — never visible, never interactive, but laid
   out so each child reports its natural width. */
.responsive-toolbar__measure {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-wrap: nowrap;
  gap: 0.5em;
  visibility: hidden;
  pointer-events: none;
  white-space: nowrap;
}
</style>
