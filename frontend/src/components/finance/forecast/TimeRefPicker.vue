<script setup lang="ts">
import { computed } from 'vue'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'
import type { ForecastMilestone, ForecastPerson, ForecastTimeRef } from '../../../api/finance'
import { parseLocalDate, toLocalIsoDate } from '../../../utils/dateFormat'

/**
 * Picks a point in time for an item: a milestone (the normal case), a
 * fixed date, or an age of a person. `null` means the caller's default
 * ("from now" or "until the end").
 */

const props = withDefaults(
  defineProps<{
    modelValue: ForecastTimeRef | null | undefined
    milestones: ForecastMilestone[]
    persons: ForecastPerson[]
    /** Label of the `null` choice, e.g. "Ab sofort". Omit to require a value. */
    nullLabel?: string
    /** Prefer this person's milestones at the top of the list. */
    personId?: number | null
    inputId?: string
  }>(),
  { nullLabel: undefined, personId: null, inputId: undefined },
)

const emit = defineEmits<{ (e: 'update:modelValue', v: ForecastTimeRef | null): void }>()

type Choice = { value: string; label: string }

const choices = computed<Choice[]>(() => {
  const out: Choice[] = []
  if (props.nullLabel) out.push({ value: 'none', label: props.nullLabel })
  const sorted = [...props.milestones].sort((a, b) => {
    const pa = a.personId === props.personId ? 0 : 1
    const pb = b.personId === props.personId ? 0 : 1
    return pa - pb || a.personId - b.personId || a.id - b.id
  })
  for (const m of sorted) {
    const p = props.persons.find((x) => x.id === m.personId)
    const who = props.persons.length > 1 && p ? ` (${p.label})` : ''
    out.push({ value: `m:${m.id}`, label: `${m.label}${who}` })
  }
  out.push({ value: 'date', label: 'Festes Datum' })
  for (const p of props.persons) out.push({ value: `age:${p.id}`, label: `Alter von ${p.label}` })
  return out
})

const choice = computed<string>(() => {
  const v = props.modelValue
  if (!v) return 'none'
  if (v.kind === 'milestone') return `m:${v.milestoneId}`
  if (v.kind === 'date') return 'date'
  return `age:${v.personId}`
})

function setChoice(value: string) {
  if (value === 'none') return emit('update:modelValue', null)
  if (value.startsWith('m:')) return emit('update:modelValue', { kind: 'milestone', milestoneId: Number(value.slice(2)) })
  if (value === 'date') {
    const existing = props.modelValue?.kind === 'date' ? props.modelValue.date : toLocalIsoDate(new Date())
    return emit('update:modelValue', { kind: 'date', date: existing })
  }
  const personId = Number(value.slice(4))
  const age = props.modelValue?.kind === 'age' ? props.modelValue.age : 65
  emit('update:modelValue', { kind: 'age', personId, age })
}

const dateValue = computed<Date | null>(() =>
  props.modelValue?.kind === 'date' ? parseLocalDate(props.modelValue.date) : null,
)

function setDate(d: Date | Date[] | (Date | null)[] | null | undefined) {
  if (!(d instanceof Date)) return
  emit('update:modelValue', { kind: 'date', date: toLocalIsoDate(d) })
}

function setAge(age: number | null) {
  if (props.modelValue?.kind !== 'age' || age == null) return
  emit('update:modelValue', { ...props.modelValue, age })
}
</script>

<template>
  <div class="timeref">
    <Select
      :model-value="choice"
      :options="choices"
      option-label="label"
      option-value="value"
      :input-id="inputId"
      class="timeref__choice"
      @update:model-value="setChoice"
    />
    <DatePicker
      v-if="modelValue?.kind === 'date'"
      :model-value="dateValue"
      date-format="dd.mm.yy"
      show-icon
      aria-label="Datum"
      class="timeref__extra"
      @update:model-value="setDate"
    />
    <InputNumber
      v-else-if="modelValue?.kind === 'age'"
      :model-value="modelValue.age"
      :min="0"
      :max="120"
      suffix=" Jahre"
      aria-label="Alter"
      class="timeref__extra"
      @update:model-value="setAge"
    />
  </div>
</template>

<style scoped>
.timeref {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.timeref__choice {
  flex: 1 1 200px;
  min-width: 0;
}
.timeref__extra {
  flex: 0 1 160px;
}
</style>
