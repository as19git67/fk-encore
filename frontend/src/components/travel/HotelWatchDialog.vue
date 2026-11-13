<script setup lang="ts">
/**
 * Create or edit a hotel price watch: one hotel or an area (with minimum
 * stars and guest rating), fixed or flexible dates (earliest arrival,
 * latest departure, nights from–to), guests, limit per night, free
 * cancellation, breakfast, plus the end of the watch, which is required and
 * at most two years ahead. The server checks the same rules
 * (travel/hotel-watch.service.ts).
 */
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import type { HotelWatch, HotelWatchInput, HotelWatchKind } from '../../api/travel'
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

const kind = ref<HotelWatchKind>('hotel')
const minStars = ref<number | null>(null)
const minRating = ref<number | null>(null)
const flexible = ref(false)
const minNights = ref<number | null>(2)
const maxNights = ref<number | null>(3)
const query = ref('')
const checkIn = ref<Date | null>(null)
const checkOut = ref<Date | null>(null)
const adults = ref<number | null>(2)
const childrenAges = ref('')
const currency = ref('EUR')
const limit = ref<number | null>(null)
const freeCancellationOnly = ref(true)
const breakfastRequired = ref(false)
const splitRooms = ref(false)
const endDate = ref<Date | null>(null)
const paused = ref(false)
const notifyPush = ref(true)
const notifyEmail = ref(true)
/** True once the user picked an end; until then it follows the check-in. */
const endTouched = ref(false)

const kindOptions = [
  { label: 'Ein Hotel', value: 'hotel' },
  { label: 'Gebiet', value: 'area' },
]
const starOptions = [
  { label: 'egal', value: null },
  { label: 'ab 3 Sterne', value: 3 },
  { label: 'ab 4 Sterne', value: 4 },
  { label: '5 Sterne', value: 5 },
]
/** Google rates on 1–5; Booking's "8+" is about Google's 4,0+. */
const ratingOptions = [
  { label: 'egal', value: null },
  { label: 'ab 3,5 (etwa 7/10)', value: 3.5 },
  { label: 'ab 4,0 (etwa 8/10)', value: 4 },
  { label: 'ab 4,5 (etwa 9/10)', value: 4.5 },
]

const tomorrow = computed(() => {
  const d = parseLocalDate(props.today)
  d.setDate(d.getDate() + 1)
  return d
})
const maxEnd = computed(() => parseLocalDate(props.maxEndDate))

/** The last day a stay may begin: the check-in, or with flexible dates the latest departure minus the shortest stay. */
const lastArrival = computed<Date | null>(() => {
  if (!flexible.value) return checkIn.value
  if (!checkOut.value) return null
  const d = new Date(checkOut.value)
  d.setDate(d.getDate() - (minNights.value ?? 1))
  return d
})

/** The day before the last possible arrival, capped at the latest allowed end. */
function defaultEnd(arrival: Date | null): Date | null {
  if (!arrival) return null
  const d = new Date(arrival)
  d.setDate(d.getDate() - 1)
  return d > maxEnd.value ? new Date(maxEnd.value) : d
}

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    const w = props.entry
    kind.value = w?.kind ?? 'hotel'
    minStars.value = w?.min_stars ?? null
    minRating.value = w?.min_rating ?? null
    flexible.value = w?.flexible ?? false
    minNights.value = w?.min_nights ?? 2
    maxNights.value = w?.max_nights ?? 3
    query.value = w?.query ?? ''
    checkIn.value = w ? parseLocalDate(w.check_in) : null
    checkOut.value = w ? parseLocalDate(w.check_out) : null
    adults.value = w?.adults ?? 2
    childrenAges.value = w?.children_ages.join(', ') ?? ''
    currency.value = w?.currency ?? 'EUR'
    limit.value = w?.limit_per_night ?? null
    freeCancellationOnly.value = w?.free_cancellation_only ?? true
    breakfastRequired.value = w?.breakfast_required ?? false
    splitRooms.value = w?.split_rooms ?? false
    endDate.value = w ? parseLocalDate(w.end_date) : null
    paused.value = w?.paused ?? false
    notifyPush.value = w?.notify_push ?? true
    notifyEmail.value = w?.notify_email ?? true
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
})

watch(lastArrival, (arrival) => {
  if (!endTouched.value) endDate.value = defaultEnd(arrival)
})

const ages = computed<number[] | null>(() => {
  const text = childrenAges.value.trim()
  if (!text) return []
  const parts = text.split(/[,;\s]+/).filter(Boolean).map(Number)
  return parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 17) ? parts : null
})

/** Double rooms for the party: only adults, an even number, at least two rooms (as the server checks). */
const splitCount = computed<number | null>(() => {
  const n = adults.value ?? 0
  return (ages.value ?? []).length === 0 && n >= 4 && n % 2 === 0 ? n / 2 : null
})

const nights = computed(() =>
  checkIn.value && checkOut.value
    ? Math.round((checkOut.value.getTime() - checkIn.value.getTime()) / 86_400_000)
    : null,
)

/** Stays a flexible watch chooses from (as `stayCombinations` counts them, without the cut). */
const combinations = computed<number | null>(() => {
  if (!flexible.value || !nights.value || !minNights.value) return null
  let n = 0
  for (let len = minNights.value; len <= Math.min(maxNights.value ?? minNights.value, nights.value); len++) {
    n += nights.value - len + 1
  }
  return n
})

const searchesHint = computed(() => {
  if (kind.value === 'area') {
    const base = 'Je Prüfung bis zu 3 Suchen: die Trefferliste und die Angebote der zwei günstigsten Hotels.'
    return flexible.value && combinations.value
      ? `${base} Jede Prüfung nimmt einen anderen Zeitraum; alle ${combinations.value} sind nach ${combinations.value} Tagen einmal dran.`
      : base
  }
  if (flexible.value) {
    return 'Je Prüfung 2 Suchen: der Preiskalender des Hotels schätzt alle Zeiträume, für den günstigsten kommen die echten Angebote.'
  }
  return null
})

const problem = computed<string | null>(() => {
  if (query.value.trim().length < 2) return kind.value === 'area' ? 'Gebiet angeben' : 'Hotel angeben'
  if (!checkIn.value || !checkOut.value) {
    return flexible.value ? 'Früheste Anreise und späteste Abreise angeben' : 'Anreise und Abreise angeben'
  }
  if ((nights.value ?? 0) < 1) return 'Die Abreise muss nach der Anreise liegen'
  if (flexible.value) {
    if (!minNights.value || minNights.value < 1) return 'Mindestens eine Nacht'
    if (!maxNights.value || maxNights.value < minNights.value) return 'Höchstens muss mindestens so viele Nächte haben wie mindestens'
    if (minNights.value > (nights.value ?? 0)) return 'Der Zeitraum ist kürzer als der kürzeste Aufenthalt'
    if ((nights.value ?? 0) > 120) return 'Der Zeitraum darf höchstens 120 Tage umfassen'
  } else if ((nights.value ?? 0) > 30) {
    return 'Höchstens 30 Nächte'
  }
  if (!adults.value || adults.value < 1) return 'Mindestens ein Erwachsener'
  if (ages.value === null) return 'Alter der Kinder: Zahlen von 0 bis 17, mit Komma getrennt'
  if (!endDate.value) return 'Ende der Beobachtung angeben'
  if (endDate.value > maxEnd.value) return 'Das Ende darf höchstens zwei Jahre in der Zukunft liegen'
  if (lastArrival.value && endDate.value >= lastArrival.value) {
    return flexible.value
      ? 'Das Ende der Beobachtung muss vor der letztmöglichen Anreise liegen'
      : 'Das Ende der Beobachtung muss vor der Anreise liegen'
  }
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
    split_rooms: kind.value === 'hotel' && splitCount.value !== null && splitRooms.value,
    kind: kind.value,
    min_stars: kind.value === 'area' ? minStars.value : null,
    min_rating: kind.value === 'area' ? minRating.value : null,
    flexible: flexible.value,
    min_nights: flexible.value ? minNights.value : null,
    max_nights: flexible.value ? maxNights.value : null,
    end_date: toLocalIsoDate(endDate.value),
    paused: paused.value,
    notify_push: notifyPush.value,
    notify_email: notifyEmail.value,
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
        <SelectButton v-model="kind" :options="kindOptions" option-label="label" option-value="value" :allow-empty="false" aria-label="Was beobachten" />
      </div>
      <div class="field field-wide">
        <label for="hw-query">{{ kind === 'area' ? 'Gebiet' : 'Hotel' }}</label>
        <InputText
          id="hw-query"
          v-bind="searchInputAttrs"
          v-model="query"
          :placeholder="kind === 'area' ? 'Ort oder Viertel, z. B. Altstadt und Stadtname' : 'Name des Hotels, gern mit Ort'"
          autofocus
        />
        <small v-if="kind === 'hotel' && entry?.hotel_name && entry.hotel_name !== query" class="muted">
          Gefunden wurde zuletzt „{{ entry.hotel_name }}“.
        </small>
      </div>
      <template v-if="kind === 'area'">
        <div class="field">
          <label for="hw-stars">Sterne</label>
          <Select v-model="minStars" input-id="hw-stars" :options="starOptions" option-label="label" option-value="value" />
        </div>
        <div class="field">
          <label for="hw-rating">Gästebewertung bei Google</label>
          <Select v-model="minRating" input-id="hw-rating" :options="ratingOptions" option-label="label" option-value="value" />
        </div>
      </template>

      <div class="field field-wide field-check">
        <Checkbox v-model="flexible" input-id="hw-flex" binary />
        <label for="hw-flex">Flexibel bei Zeitpunkt und Dauer</label>
      </div>
      <div class="field">
        <label for="hw-in">{{ flexible ? 'Früheste Anreise' : 'Anreise' }}</label>
        <DatePicker v-model="checkIn" input-id="hw-in" date-format="dd.mm.yy" :min-date="tomorrow" show-icon />
      </div>
      <div class="field">
        <label for="hw-out">{{ flexible ? 'Späteste Abreise' : 'Abreise' }}</label>
        <DatePicker v-model="checkOut" input-id="hw-out" date-format="dd.mm.yy" :min-date="checkIn ?? tomorrow" show-icon />
        <small v-if="nights && !flexible" class="muted">{{ nights }} {{ nights === 1 ? 'Nacht' : 'Nächte' }}</small>
        <small v-else-if="nights" class="muted">Zeitraum von {{ nights + 1 }} Tagen</small>
      </div>
      <template v-if="flexible">
        <div class="field">
          <label for="hw-min-nights">Nächte mindestens</label>
          <InputNumber v-model="minNights" input-id="hw-min-nights" :min="1" :max="30" show-buttons />
        </div>
        <div class="field">
          <label for="hw-max-nights">Nächte höchstens</label>
          <InputNumber v-model="maxNights" input-id="hw-max-nights" :min="1" :max="30" show-buttons />
        </div>
      </template>
      <small v-if="searchesHint" class="field-wide muted">{{ searchesHint }}</small>

      <div class="field">
        <label for="hw-adults">Erwachsene</label>
        <InputNumber v-model="adults" input-id="hw-adults" :min="1" :max="10" show-buttons />
      </div>
      <div class="field">
        <label for="hw-children">Alter der Kinder</label>
        <InputText id="hw-children" v-model="childrenAges" placeholder="z. B. 8, 12" />
      </div>
      <div v-if="kind === 'hotel' && splitCount !== null" class="field field-wide field-check split">
        <Checkbox v-model="splitRooms" input-id="hw-split" binary />
        <label for="hw-split">Auch {{ splitCount }} Doppelzimmer à 2 Erwachsene prüfen</label>
        <small class="muted">
          Eine zweite Suche je Prüfung. Der Preis gilt für alle Zimmer zusammen; ob so viele frei sind, zeigt erst der Anbieter.
        </small>
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

      <fieldset class="field field-wide notify">
        <legend>Melden, wenn der Preis unter die Grenze fällt</legend>
        <div class="field-check">
          <Checkbox v-model="notifyPush" input-id="hw-push" binary :disabled="limit === null" />
          <label for="hw-push">Push-Benachrichtigung</label>
        </div>
        <div class="field-check">
          <Checkbox v-model="notifyEmail" input-id="hw-mail" binary :disabled="limit === null" />
          <label for="hw-mail">E-Mail</label>
        </div>
        <small class="muted">
          {{ limit === null ? 'Ohne Grenze gibt es nichts zu melden.' : 'Einmal, und wieder bei einem neuen Tiefstpreis. Steigt der Preis über die Grenze, wird der nächste Fall wieder gemeldet.' }}
        </small>
      </fieldset>

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
        <small class="muted">
          {{ flexible ? 'Spätestens am Tag vor der letztmöglichen Anreise' : 'Spätestens am Tag vor der Anreise' }}, höchstens zwei Jahre ab heute.
        </small>
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
.split {
  flex-wrap: wrap;
}
.split small {
  flex-basis: 100%;
}
.notify {
  border: 0;
  margin: 0;
  padding: 0;
}
.notify legend {
  padding: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  margin-bottom: var(--space-1);
}
.notify .field-check {
  display: flex;
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
