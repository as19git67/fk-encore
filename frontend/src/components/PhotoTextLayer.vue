<script setup lang="ts">
/**
 * Recognised text laid over a photo, selectable like text on a page (#1029).
 *
 * The trick is the one PDF viewers use: the real text sits over the image,
 * invisible, in boxes that match where the words are — so the browser's own
 * selection does the work. Drag across lines, double-click a word, ⌘/Ctrl+C,
 * the context menu: none of that is re-implemented here.
 *
 * Every line is placed as the detector's quadrilateral (see utils/ocrLayout),
 * so a selection on a tilted sign runs along the letters. The font is sized
 * to the box height; the box width is met by measuring the rendered text and
 * stretching it horizontally, which is what puts the selection highlight over
 * the letters in the photo rather than over the font's idea of them.
 *
 * The layer lives inside the image's slot, which is already the rendered
 * image box, so positions are percentages of it. Only the lines take pointer
 * events — the gaps between them still pan and pinch the photo.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { PhotoOcrBlock } from '../api/photos'
import {
  fitScaleX,
  isVisibleLayout,
  lineLayout,
  mapBlockIntoView,
  type LineLayout,
  type ViewTransform,
} from '../utils/ocrLayout'

const props = withDefaults(defineProps<{
  blocks: PhotoOcrBlock[]
  /**
   * The crop and rotation the displayed image was rendered with, when the
   * viewer shows a saved recipe. Coordinates arrive relative to the original
   * and are re-based onto that view here — a line the crop cut off is dropped.
   */
  view?: ViewTransform | null
  /** True while the user is in text mode: lines become selectable and visible. */
  active?: boolean
  /** Lines the detector was less sure about than this are shown dimmed. */
  dimBelowConfidence?: number
}>(), {
  view: null,
  active: false,
  dimBelowConfidence: 0.7,
})

interface PlacedLine {
  key: string
  text: string
  dim: boolean
  layout: LineLayout
}

const placed = computed<PlacedLine[]>(() => {
  const out: PlacedLine[] = []
  props.blocks.forEach((block, i) => {
    const mapped = props.view ? mapBlockIntoView(block, props.view) : block
    const layout = lineLayout(mapped)
    if (layout.width <= 0 || layout.height <= 0 || !isVisibleLayout(layout)) return
    out.push({
      key: `${i}:${block.text}`,
      text: block.text,
      dim: block.confidence < props.dimBelowConfidence,
      layout,
    })
  })
  return out
})

const root = ref<HTMLElement | null>(null)
const lineEls = ref<HTMLElement[]>([])
const layerSize = ref({ width: 0, height: 0 })
/** Per line: the horizontal stretch that makes the rendered text fill its box. */
const scaleX = ref<number[]>([])

function boxHeightPx(layout: LineLayout): number {
  return layout.height * layerSize.value.height
}

function boxWidthPx(layout: LineLayout): number {
  return layout.width * layerSize.value.width
}

/**
 * Measure every line at scale 1 and derive the stretch to its box. Done after
 * the DOM has the lines and again whenever the layer changes size (window
 * resize, details panel opening, orientation change).
 */
async function measure() {
  await nextTick()
  const next: number[] = []
  placed.value.forEach((line, i) => {
    const el = lineEls.value[i]
    if (!el) { next.push(1); return }
    // scrollWidth is unaffected by the transform, unlike getBoundingClientRect.
    next.push(fitScaleX(el.scrollWidth, boxWidthPx(line.layout)))
  })
  scaleX.value = next
}

let observer: ResizeObserver | null = null

onMounted(() => {
  if (root.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      layerSize.value = { width: rect.width, height: rect.height }
      void measure()
    })
    observer.observe(root.value)
  } else if (root.value) {
    layerSize.value = { width: root.value.clientWidth, height: root.value.clientHeight }
    void measure()
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(placed, () => { void measure() })

function lineStyle(line: PlacedLine, i: number): Record<string, string> {
  const { x, y, width, height, angle } = line.layout
  const fontPx = Math.max(6, boxHeightPx(line.layout) * 0.8)
  const sx = scaleX.value[i] ?? 1
  return {
    left: `${(x * 100).toFixed(3)}%`,
    top: `${(y * 100).toFixed(3)}%`,
    width: `${(width * 100).toFixed(3)}%`,
    height: `${(height * 100).toFixed(3)}%`,
    fontSize: `${fontPx.toFixed(2)}px`,
    lineHeight: `${Math.max(1, boxHeightPx(line.layout)).toFixed(2)}px`,
    // Rotation first (about the box's top-left corner, where the quad is
    // anchored), then the horizontal fit inside that rotated frame.
    transform: `rotate(${angle}rad) scaleX(${sx.toFixed(4)})`,
  }
}

/** All text, in reading order, for the host's copy action. */
const fullText = computed(() => placed.value.map(l => l.text).join('\n'))
defineExpose({ fullText })
</script>

<template>
  <div
    ref="root"
    class="photo-text-layer"
    :class="{ 'photo-text-layer--active': active }"
    aria-label="Text im Bild"
  >
    <span
      v-for="(line, i) in placed"
      :key="line.key"
      ref="lineEls"
      class="photo-text-line"
      :class="{ 'photo-text-line--dim': line.dim }"
      :style="lineStyle(line, i)"
    >{{ line.text }}</span>
  </div>
</template>

<style scoped>
.photo-text-layer {
  position: absolute;
  inset: 0;
  /* Never a target itself: the gaps between lines still pan and zoom. */
  pointer-events: none;
  overflow: visible;
}

.photo-text-line {
  position: absolute;
  transform-origin: 0 0;
  box-sizing: border-box;
  display: block;
  white-space: pre;
  color: transparent;
  /* Text is metric-agnostic here; a wide sans keeps the stretch factors
     close to 1 for most Latin signage. */
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
  -webkit-user-select: none;
  pointer-events: none;
  cursor: default;
  border-radius: 2px;
  transition: background-color 120ms ease;
}

/* Text mode: the lines announce themselves and take the pointer. Selection
   colour stays the platform's own, so the highlight reads as "text". */
.photo-text-layer--active .photo-text-line {
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
  background-color: rgba(255, 220, 80, 0.22);
  box-shadow: 0 0 0 1px rgba(255, 220, 80, 0.45);
}

.photo-text-layer--active .photo-text-line--dim {
  background-color: rgba(255, 220, 80, 0.1);
  box-shadow: 0 0 0 1px rgba(255, 220, 80, 0.25);
}

.photo-text-line::selection {
  background: rgba(70, 140, 255, 0.55);
  color: transparent;
}
</style>
