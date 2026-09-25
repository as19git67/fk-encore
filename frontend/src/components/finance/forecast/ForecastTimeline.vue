<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ForecastMilestone, ForecastPerson, ForecastResolvedMilestone } from '../../../api/finance'
import { MILESTONE_KIND_LABELS } from './forecastModel'

/**
 * One row per person, all milestones on the shared year axis. A milestone
 * can be dragged along its row; that moves the *scenario override*, not
 * the milestone itself — scenarios are what change milestones (#1337).
 */

const props = defineProps<{
  persons: ForecastPerson[]
  milestones: ForecastMilestone[]
  resolved: ForecastResolvedMilestone[]
  startYear: number
  endYear: number
  /** Milestones the current scenario has moved away from their stored value. */
  overriddenIds: ReadonlySet<number>
}>()

const emit = defineEmits<{
  (e: 'move', payload: { milestoneId: number; age: number }): void
  (e: 'edit', milestoneId: number): void
  (e: 'add', personId: number): void
}>()

const width = 1000
const rowHeight = 44
const left = 8
const right = 8
const years = computed(() => Math.max(1, props.endYear - props.startYear))
const height = computed(() => props.persons.length * rowHeight + 28)

function x(year: number): number {
  return left + ((year - props.startYear) / years.value) * (width - left - right)
}

const ticks = computed(() => {
  const step = years.value > 40 ? 10 : 5
  const out: number[] = []
  for (let y = Math.ceil(props.startYear / step) * step; y <= props.endYear; y += step) out.push(y)
  return out
})

const KIND_ICON: Record<string, string> = {
  leave_work: '⏻',
  statutory_pension: 'R',
  company_pension: 'B',
  private_pension: 'P',
  life_insurance_maturity: 'LV',
  custom: '•',
}

interface Marker {
  id: number
  personId: number
  label: string
  kind: string
  year: number
  age: number
  x: number
  y: number
  overridden: boolean
}

const markers = computed<Marker[]>(() =>
  props.resolved
    .map((m): Marker | null => {
      const row = props.persons.findIndex((p) => p.id === m.personId)
      if (row < 0) return null
      return {
        id: m.id,
        personId: m.personId,
        label: m.label,
        kind: m.kind,
        year: m.year,
        age: m.age,
        x: x(m.year + 0.5),
        y: row * rowHeight + 22,
        overridden: props.overriddenIds.has(m.id),
      }
    })
    .filter((m): m is Marker => m !== null),
)

// ---- dragging ------------------------------------------------------------

const svg = ref<SVGSVGElement | null>(null)
const drag = ref<{ id: number; personId: number; year: number; startX: number; moved: boolean } | null>(null)

function yearFromClientX(clientX: number): number {
  const el = svg.value
  if (!el) return props.startYear
  const rect = el.getBoundingClientRect()
  const px = ((clientX - rect.left) / rect.width) * width
  const y = props.startYear + ((px - left) / (width - left - right)) * years.value
  return Math.min(props.endYear, Math.max(props.startYear, Math.round(y - 0.5)))
}

function onPointerDown(m: Marker, ev: PointerEvent) {
  ;(ev.currentTarget as Element).setPointerCapture(ev.pointerId)
  drag.value = { id: m.id, personId: m.personId, year: m.year, startX: ev.clientX, moved: false }
}

function onPointerMove(ev: PointerEvent) {
  if (!drag.value) return
  if (Math.abs(ev.clientX - drag.value.startX) > 3) drag.value.moved = true
  drag.value.year = yearFromClientX(ev.clientX)
}

function onPointerUp(m: Marker) {
  const d = drag.value
  drag.value = null
  if (!d) return
  if (!d.moved) {
    emit('edit', m.id)
    return
  }
  const person = props.persons.find((p) => p.id === d.personId)
  if (!person) return
  const age = d.year - Number(person.birthDate.slice(0, 4))
  if (age !== m.age) emit('move', { milestoneId: m.id, age })
}

function onKey(m: Marker, ev: KeyboardEvent) {
  const delta = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0
  if (delta === 0) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      emit('edit', m.id)
    }
    return
  }
  ev.preventDefault()
  emit('move', { milestoneId: m.id, age: m.age + delta })
}

function markerX(m: Marker): number {
  return drag.value?.id === m.id ? x(drag.value.year + 0.5) : m.x
}

function markerYear(m: Marker): number {
  return drag.value?.id === m.id ? drag.value.year : m.year
}
</script>

<template>
  <div class="timeline">
    <div class="timeline__persons" aria-hidden="true">
      <div v-for="p in persons" :key="p.id" class="timeline__person" :style="{ height: rowHeight + 'px' }">
        <span class="timeline__person-name">{{ p.label }}</span>
        <button type="button" class="timeline__add" aria-label="Zeitpunkt hinzufügen" title="Zeitpunkt hinzufügen" @click="emit('add', p.id)">
          <i class="pi pi-plus" aria-hidden="true" />
        </button>
      </div>
    </div>
    <svg
      ref="svg"
      class="timeline__svg"
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="none"
      role="list"
      aria-label="Zeitleiste der Zeitpunkte"
      @pointermove="onPointerMove"
    >
      <g v-for="(p, i) in persons" :key="p.id">
        <line :x1="left" :x2="width - right" :y1="i * rowHeight + 22" :y2="i * rowHeight + 22" class="timeline__row" />
      </g>
      <g v-for="t in ticks" :key="t">
        <line :x1="x(t)" :x2="x(t)" :y1="0" :y2="height - 20" class="timeline__tick" />
        <text :x="x(t)" :y="height - 6" class="timeline__tick-label" text-anchor="middle">{{ t }}</text>
      </g>
      <g
        v-for="m in markers"
        :key="m.id"
        role="listitem"
        tabindex="0"
        class="timeline__marker"
        :class="{ 'timeline__marker--overridden': m.overridden, 'timeline__marker--dragging': drag?.id === m.id }"
        :transform="`translate(${markerX(m)}, ${m.y})`"
        :aria-label="`${m.label}: ${markerYear(m)}, mit ${m.age}. Pfeiltasten verschieben, Eingabe bearbeitet.`"
        @pointerdown="onPointerDown(m, $event)"
        @pointerup="onPointerUp(m)"
        @pointercancel="drag = null"
        @keydown="onKey(m, $event)"
      >
        <title>{{ m.label }} ({{ MILESTONE_KIND_LABELS[m.kind as keyof typeof MILESTONE_KIND_LABELS] ?? m.kind }}) — {{ markerYear(m) }}, mit {{ m.age }}</title>
        <circle r="11" class="timeline__dot" />
        <text y="4" text-anchor="middle" class="timeline__dot-label">{{ KIND_ICON[m.kind] ?? '•' }}</text>
        <text y="-15" text-anchor="middle" class="timeline__year">{{ markerYear(m) }}</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.timeline {
  display: grid;
  grid-template-columns: minmax(72px, auto) 1fr;
  gap: var(--space-2);
  align-items: start;
}
.timeline__person {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
.timeline__person-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline__add {
  border: none;
  background: transparent;
  color: var(--p-text-muted-color);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: 999px;
  font-size: var(--text-sm);
}
.timeline__add:hover {
  background: var(--p-content-hover-background);
}
.timeline__add:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.timeline__svg {
  width: 100%;
  height: auto;
  min-height: 60px;
  overflow: visible;
  touch-action: pan-y;
}
.timeline__row {
  stroke: var(--p-content-border-color);
  stroke-width: 2;
}
.timeline__tick {
  stroke: var(--p-content-border-color);
  stroke-dasharray: 3 5;
}
.timeline__tick-label {
  fill: var(--p-text-muted-color);
  font-size: 12px; /* audit-ok: SVG user units inside a scaled viewBox, not CSS text */
}
.timeline__marker {
  cursor: grab;
}
.timeline__marker--dragging {
  cursor: grabbing;
}
.timeline__marker:focus-visible {
  outline: none;
}
.timeline__marker:focus-visible .timeline__dot {
  stroke: var(--p-primary-color);
  stroke-width: 4;
}
.timeline__dot {
  fill: var(--p-content-background);
  stroke: var(--p-primary-color);
  stroke-width: 2.5;
}
.timeline__marker--overridden .timeline__dot {
  fill: var(--p-primary-color);
}
.timeline__dot-label {
  fill: var(--p-text-color);
  font-size: 10px; /* audit-ok: SVG user units inside a scaled viewBox */
  font-weight: 700;
  pointer-events: none;
}
.timeline__marker--overridden .timeline__dot-label {
  fill: var(--p-primary-contrast-color);
}
.timeline__year {
  fill: var(--p-text-muted-color);
  font-size: 11px; /* audit-ok: SVG user units inside a scaled viewBox */
  pointer-events: none;
}
</style>
