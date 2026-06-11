<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import Select from 'primevue/select'
import DatePicker from 'primevue/datepicker'

const props = defineProps<{
  from: Date | null
  to: Date | null
}>()

const emit = defineEmits<{
  (e: 'update:from', v: Date | null): void
  (e: 'update:to', v: Date | null): void
}>()

const year = ref<number | null>(null)
const month = ref<number | null>(null)
const presetKey = ref(0)
let applyingPreset = false

const currentYear = new Date().getFullYear()
const yearOptions = computed(() => {
  const opts: Array<{ label: string; value: number | null }> = [{ label: '—', value: null }]
  for (let y = currentYear; y >= 1990; y--) opts.push({ label: String(y), value: y })
  return opts
})
const monthOptions: Array<{ label: string; value: number | null }> = [
  { label: '—', value: null },
  { label: 'Januar', value: 0 },
  { label: 'Februar', value: 1 },
  { label: 'März', value: 2 },
  { label: 'April', value: 3 },
  { label: 'Mai', value: 4 },
  { label: 'Juni', value: 5 },
  { label: 'Juli', value: 6 },
  { label: 'August', value: 7 },
  { label: 'September', value: 8 },
  { label: 'Oktober', value: 9 },
  { label: 'November', value: 10 },
  { label: 'Dezember', value: 11 },
]

function computeRange(y: number | null, m: number | null): { from: Date | null; to: Date | null } {
  if (y === null && m === null) return { from: null, to: null }
  const ey = y ?? currentYear
  if (m !== null) {
    return { from: new Date(ey, m, 1), to: new Date(ey, m + 1, 0) }
  }
  return { from: new Date(ey, 0, 1), to: new Date(ey, 11, 31) }
}

function applyPreset(y: number | null, m: number | null) {
  const { from, to } = computeRange(y, m)
  applyingPreset = true
  presetKey.value++
  emit('update:from', from)
  emit('update:to', to)
  nextTick(() => { applyingPreset = false })
}

function onYearChange(v: number | null) {
  if (v === null) {
    year.value = null
    month.value = null
    applyPreset(null, null)
    return
  }
  year.value = v
  applyPreset(v, month.value)
}

function onMonthChange(v: number | null) {
  month.value = v
  if (v !== null && year.value === null) year.value = currentYear
  applyPreset(year.value, month.value)
}

function onFromChange(v: Date | (Date | null)[] | Date[] | null | undefined) {
  emit('update:from', v && !Array.isArray(v) ? v : null)
}

function onToChange(v: Date | (Date | null)[] | Date[] | null | undefined) {
  emit('update:to', v && !Array.isArray(v) ? v : null)
}

// Reset preset dropdowns whenever from/to is edited outside this component
// (e.g. by the user picking a date manually, or the parent resetting state).
watch(() => [props.from, props.to], () => {
  if (applyingPreset) return
  year.value = null
  month.value = null
})
</script>

<template>
  <div class="daterange-presets">
    <div class="preset-row">
      <Select
        :model-value="year"
        :options="yearOptions"
        option-label="label"
        option-value="value"
        placeholder="Jahr"
        class="preset-select"
        @update:model-value="onYearChange"
      />
      <Select
        :model-value="month"
        :options="monthOptions"
        option-label="label"
        option-value="value"
        placeholder="Monat"
        class="preset-select"
        @update:model-value="onMonthChange"
      />
    </div>
    <div class="picker-row">
      <DatePicker
        :key="`from-${presetKey}`"
        :model-value="props.from"
        date-format="dd.mm.yy"
        placeholder="Von"
        show-icon
        @update:model-value="onFromChange"
      />
      <DatePicker
        :key="`to-${presetKey}`"
        :model-value="props.to"
        date-format="dd.mm.yy"
        placeholder="Bis"
        show-icon
        @update:model-value="onToChange"
      />
    </div>
  </div>
</template>

<style scoped>
.daterange-presets { display: flex; flex-direction: column; gap: 0.5rem; }
.preset-row, .picker-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.preset-row > *, .picker-row > * { flex: 1 1 140px; min-width: 0; }
.preset-select { width: 100%; }
</style>
