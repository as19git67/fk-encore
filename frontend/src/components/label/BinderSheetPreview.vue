<script setup lang="ts">
/**
 * The page of binder labels as it will print: an SVG in PDF points, drawn
 * from the same layout the server uses (`utils/binderLayout.ts`), so lines
 * break where they break on paper.
 *
 * `view="sheet"` shows the A4 sheet; `view="spine"` stands the four labels
 * up side by side as they will look on the files — the left end of a label
 * goes to the top of the spine. A tap on a label asks the page to focus its
 * field.
 */
import { computed } from 'vue'
import {
  BINDER_SHEET,
  contentFrame,
  layoutBinderSheet,
  mmToPt,
  type BinderDirection,
  type LabelLayout,
} from '../../utils/binderLayout'
import { BINDER_FONT } from '../../composables/useBinderLayout'

const props = defineProps<{
  layouts: LabelLayout[]
  direction: BinderDirection
  view: 'sheet' | 'spine'
  /** The label whose field has the focus, drawn highlighted. */
  active?: number | null
}>()

const emit = defineEmits<{ select: [index: number] }>()

const pad = mmToPt(BINDER_SHEET.paddingMm)
const labelW = mmToPt(BINDER_SHEET.labelWidthMm)
const labelH = mmToPt(BINDER_SHEET.labelHeightMm)
const SPINE_GAP = 18

const frame = computed(() => contentFrame(props.direction))

interface Slot {
  index: number
  /** The label's outline in the drawing. */
  x: number
  y: number
  width: number
  height: number
  /** Moves the label's upright text frame into place. */
  transform: string
}

const slots = computed<Slot[]>(() => {
  if (props.view === 'sheet') {
    return layoutBinderSheet().map((box) => ({
      ...box,
      transform:
        props.direction === 'across'
          ? `translate(${box.x + pad} ${box.y + box.height - pad}) rotate(-90)`
          : `translate(${box.x + pad} ${box.y + pad})`,
    }))
  }
  // Standing: each label is 61 wide and 192 tall.
  return layoutBinderSheet().map((box) => {
    const x = SPINE_GAP + box.index * (labelH + SPINE_GAP)
    const y = SPINE_GAP
    return {
      index: box.index,
      x,
      y,
      width: labelH,
      height: labelW,
      transform:
        props.direction === 'across'
          ? `translate(${x + pad} ${y + pad})`
          : `translate(${x + labelH - pad} ${y + pad}) rotate(90)`,
    }
  })
})

const viewBox = computed(() =>
  props.view === 'sheet'
    ? `0 0 ${BINDER_SHEET.pageWidthPt} ${BINDER_SHEET.pageHeightPt}`
    : `0 0 ${SPINE_GAP + BINDER_SHEET.labels * (labelH + SPINE_GAP)} ${labelW + 2 * SPINE_GAP}`,
)

const ariaLabel = computed(() =>
  props.view === 'sheet' ? 'Vorschau der Seite mit vier Ordneretiketten' : 'Vorschau der Etiketten am Ordnerrücken',
)

function label(index: number): string {
  const l = props.layouts[index]
  const text = l?.pieces.map((p) => p.text).join(' ').trim()
  return `Etikett ${index + 1}${text ? `: ${text}` : ', leer'}`
}
</script>

<template>
  <svg
    class="sheet"
    :class="{ 'sheet--spine': view === 'spine' }"
    :viewBox="viewBox"
    role="img"
    :aria-label="ariaLabel"
  >
    <defs>
      <clipPath v-for="slot in slots" :id="`binder-clip-${view}-${slot.index}`" :key="slot.index">
        <rect :x="slot.x" :y="slot.y" :width="slot.width" :height="slot.height" />
      </clipPath>
    </defs>
    <rect
      v-if="view === 'sheet'"
      class="paper"
      x="0"
      y="0"
      :width="BINDER_SHEET.pageWidthPt"
      :height="BINDER_SHEET.pageHeightPt"
    />
    <g
      v-for="slot in slots"
      :key="slot.index"
      class="label"
      :class="{ 'label--active': active === slot.index, 'label--overflow': layouts[slot.index]?.overflow }"
      @click="emit('select', slot.index)"
    >
      <title>{{ label(slot.index) }}</title>
      <rect class="label-face" :x="slot.x" :y="slot.y" :width="slot.width" :height="slot.height" rx="4" />
      <g :clip-path="`url(#binder-clip-${view}-${slot.index})`">
        <g :transform="slot.transform">
          <line
            v-for="(rule, i) in layouts[slot.index]?.rules ?? []"
            :key="`r${i}`"
            class="ink-line"
            x1="0"
            :x2="frame.width"
            :y1="rule.y"
            :y2="rule.y"
            stroke-width="0.8"
          />
          <template v-for="(piece, i) in layouts[slot.index]?.pieces ?? []" :key="i">
            <text
              class="ink"
              :x="piece.x"
              :y="piece.baseline"
              :font-family="BINDER_FONT"
              :font-size="piece.size"
              :font-weight="piece.bold ? 700 : 400"
              :font-style="piece.italic ? 'italic' : 'normal'"
              xml:space="preserve"
            >{{ piece.text }}</text>
            <line
              v-if="piece.strike"
              class="ink-line"
              :x1="piece.x"
              :x2="piece.x + piece.width"
              :y1="piece.baseline - piece.size * 0.28"
              :y2="piece.baseline - piece.size * 0.28"
              :stroke-width="piece.size / 16"
            />
          </template>
        </g>
      </g>
      <rect class="label-edge" :x="slot.x" :y="slot.y" :width="slot.width" :height="slot.height" rx="4" />
    </g>
  </svg>
</template>

<style scoped>
.sheet {
  display: block;
  width: 100%;
  height: auto;
}
/* The sheet is white paper in either theme; the preview shows it as printed. */
.paper,
.label-face {
  fill: #ffffff; /* audit-ok: printed paper, white regardless of theme */
}
.ink {
  fill: #000000; /* audit-ok: printed ink, black regardless of theme */
  white-space: pre;
}
.ink-line {
  stroke: #000000; /* audit-ok: printed ink, black regardless of theme */
}
.label {
  cursor: pointer;
}
.label-edge {
  fill: none;
  stroke: var(--p-content-border-color);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}
.label--active .label-edge {
  stroke: var(--p-primary-color);
  stroke-width: 2.5;
  stroke-dasharray: none;
}
.label--overflow .label-edge {
  stroke: var(--p-message-warn-color, var(--p-primary-color));
  stroke-width: 2.5;
  stroke-dasharray: none;
}
.sheet--spine .label-face {
  stroke: var(--p-content-border-color);
}
</style>
