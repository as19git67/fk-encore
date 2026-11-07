<script setup lang="ts">
/**
 * Create or edit a hotel price watch: the criteria of the test script
 * (hotel, dates, guests, limit per night, free cancellation, breakfast) plus
 * the end of the watch, which is required and at most two years ahead.
 * The server checks the same rules (travel/hotel-watch.service.ts).
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import type { HotelWatch, HotelWatchInput } from '../../api/travel'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'
import { searchInputAttrs } from '../../utils/searchInputAttrs'

const props = defineProps<{
  visible: boolean
  /** The watch to edit; null creates a new one. */
  entry: HotelWatch | null
  /** Today and the latest allowed end, from the server. */
  today: string
  maxEndDate: string
  saving: boolean
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'save', input: HotelWatchInput): void
}>()

const query = ref('')
const checkIn = ref<Date | null>(null)
const checkOut = ref<Date | null>(null)
const adults = ref<number | null>(2)
const childrenAges = ref('')
const currency = ref('EUR')
const limit = ref<number | null>(null)
const freeCancellationOnly = ref(true)
const breakfastRequired = ref(false)
const endDate = ref<Date | null>(null)
const paused = ref(false)
/** True once the user picked an end; until then it follows the check-in. */
const endTouched = ref(false)

const tomorrow = computed(() => {
  const d = parseLocalDate(props.today)
  d.setDate(d.getDate() + 1)
  return d
})
const maxEnd = computed(() => parseLocalDate(props.maxEndDate))

/** The day before the check-in, capped at the latest allowed end. */
function defaultEnd(ci: Date | null): Date | null {
  if (!ci) return null
  const d = new Date(ci)
  d.setDate(d.getDate() - 1)
  return d > maxEnd.value ? new Date(maxEnd.value) : d
}

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    const w = props.entry
    query.value = w?.query ?? ''
    checkIn.value = w ? parseLocalDate(w.check_in) : null
    checkOut.value = w ? parseLocalDate(w.check_out) : null
    adults.value = w?.adults ?? 2
    childrenAges.value = w?.children_ages.join(', ') ?? ''
    currency.value = w?.currency ?? 'EUR'
    limit.value = w?.limit_per_night ?? null
    freeCancellationOnly.value = w?.free_cancellation_only ?? true
    breakfastRequired.value = w?.breakfast_required ?? false
    endDate.value = w ? parseLocalDate(w.end_date) : null
    paused.value = w?.paused ?? false
    endTouched.value = !!w
  },
  { immediate: true },
)

watch(checkIn, (ci) => {
  if (ci && checkOut.value && checkOut.value <= ci) {
    const d = new Date(ci)
    d.setDate(d.getDate() + 1)
    checkOut.value = d
  }
  if (!endTouched.value) endDate.value = defaultEnd(ci)
})

const ages = computed<number[] | null>(() => {
  const text = childrenAges.value.trim()
  if (!text) return []
  const parts = text.split(/[,;\s]+/).filter(Boolean).map(Number)
  return parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 17) ? parts : null
})

const nights = computed(() =>
  checkIn.value && checkOut.value
    ? Math.round((checkOut.value.getTime() - checkIn.value.getTime()) / 86_400_000)
    : null,
)

const problem = computed<string | null>(() => {
  if (query.value.trim().length < 2) return 'Hotel angeben'
  if (!checkIn.value || !checkOut.value) return 'Anreise und Abreise angeben'
  if ((nights.value ?? 0) < 1) return 'Die Abreise muss nach der Anreise liegen'
  if (!adults.value || adults.value < 1) return 'Mindestens ein Erwachsener'
  if (ages.value === null) return 'Alter der Kinder: Zahlen von 0 bis 17, mit Komma getrennt'
  if (!endDate.value) return 'Ende der Beobachtung angeben'
  if (endDate.value > maxEnd.value) return 'Das Ende darf höchstens zwei Jahre in der Zukunft liegen'
  if (endDate.value >= checkIn.value) return 'Das Ende der Beobachtung muss vor der Anreise liegen'
  return null
})

function save() {
  if (problem.value || !checkIn.value || !checkOut.value || !endDate.value) return
  emit('save', {
    query: query.value.trim(),
    check_in: toLocalIsoDate(checkIn.value),
    check_out: toLocalIsoDate(checkOut.value),
    adults: adults.value ?? 1,
    children_ages: ages.value ?? [],
    currency: currency.value.trim().toUpperCase() || 'EUR',
    limit_per_night: limit.value,
    free_cancellation_only: freeCancellationOnly.value,
    breakfast_required: breakfastRequired.value,
    end_date: toLocalIsoDate(endDate.value),
    paused: paused.value,
  })
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    :header="entry ? 'Wächter bearbeiten' : 'Neuer Hotelpreis-Wächter'"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <form class="hw-form" @submit.prevent="save">
      <div class="field field-wide">
        <label for="hw-query">Hotel</label>
        <InputText id="hw-query" v-bind="searchInputAttrs" v-model="query" placeholder="Name des Hotels, gern mit Ort" autofocus />
        <small v-if="entry?.hotel_name && entry.hotel_name !== query" class="muted">
          Gefunden wurde zuletzt „{{ entry.hotel_name }}“.
        </small>
      </div>

      <div class="field">
        <label for="hw-in">Anreise</label>
        <DatePicker v-model="checkIn" input-id="hw-in" date-format="dd.mm.yy" :min-date="tomorrow" show-icon />
      </div>
      <div class="field">
        <label for="hw-out">Abreise</label>
        <DatePicker v-model="checkOut" input-id="hw-out" date-format="dd.mm.yy" :min-date="checkIn ?? tomorrow" show-icon />
        <small v-if="nights" class="muted">{{ nights }} {{ nights === 1 ? 'Nacht' : 'Nächte' }}</small>
      </div>

      <div class="field">
        <label for="hw-adults">Erwachsene</label>
        <InputNumber v-model="adults" input-id="hw-adults" :min="1" :max="10" show-buttons />
      </div>
      <div class="field">
        <label for="hw-children">Alter der Kinder</label>
        <InputText id="hw-children" v-model="childrenAges" placeholder="z. B. 8, 12" />
      </div>

      <div class="field">
        <label for="hw-limit">Grenze pro Nacht (inkl. Steuern)</label>
        <InputNumber v-model="limit" input-id="hw-limit" :min="1" :max="100000" placeholder="ohne Grenze" />
      </div>
      <div class="field">
        <label for="hw-currency">Währung</label>
        <InputText id="hw-currency" v-model="currency" maxlength="3" />
      </div>

      <div class="field field-wide field-check">
        <Checkbox v-model="freeCancellationOnly" input-id="hw-free" binary />
        <label for="hw-free">Nur kostenlos stornierbare Tarife zählen</label>
      </div>
      <div class="field field-wide field-check">
        <Checkbox v-model="breakfastRequired" input-id="hw-breakfast" binary />
        <label for="hw-breakfast">Nur Tarife mit Frühstück zählen</label>
      </div>

      <div class="field">
        <label for="hw-end">Ende der Beobachtung</label>
        <DatePicker
          v-model="endDate"
          input-id="hw-end"
          date-format="dd.mm.yy"
          :min-date="parseLocalDate(today)"
          :max-date="maxEnd"
          show-icon
          @update:model-value="endTouched = true"
        />
        <small class="muted">Spätestens am Tag vor der Anreise, höchstens zwei Jahre ab heute.</small>
      </div>
      <div v-if="entry" class="field field-check field-end">
        <Checkbox v-model="paused" input-id="hw-paused" binary />
        <label for="hw-paused">Pausiert</label>
      </div>

      <Message v-if="error" class="field-wide" severity="error" :closable="false">{{ error }}</Message>
      <button type="submit" hidden aria-hidden="true" tabindex="-1" />
    </form>

    <template #footer>
      <span v-if="problem" class="muted footer-hint">{{ problem }}</span>
      <Button label="Abbrechen" text severity="secondary" @click="emit('update:visible', false)" />
      <Button
        :label="entry ? 'Speichern' : 'Anlegen'"
        icon="pi pi-check"
        :disabled="!!problem"
        :loading="saving"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.hw-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
@media (max-width: 639px) {
  .hw-form {
    grid-template-columns: minmax(0, 1fr);
  }
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.field-wide {
  grid-column: 1 / -1;
}
.field label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.field-check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}
.field-check label {
  color: var(--p-text-color);
}
.field-end {
  align-self: end;
  padding-bottom: var(--space-2);
}
.muted {
  color: var(--p-text-muted-color);
  font-size: var(--text-xs);
}
.footer-hint {
  margin-right: auto;
  font-size: var(--text-sm);
}
</style>
