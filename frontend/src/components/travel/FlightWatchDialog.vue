<script setup lang="ts">
/**
 * Create or edit a flight price watch: route, fixed dates or a flexible
 * window with a range of nights, passengers, class, stops, airlines,
 * departure hours, the limit for the whole trip, and the end of the watch.
 * The server checks the same rules (travel/flight-watch.service.ts).
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
import type { AirlinesMode, FlightTripType, FlightWatch, FlightWatchInput } from '../../api/travel'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'

const props = defineProps<{
  visible: boolean
  entry: FlightWatch | null
  today: string
  maxEndDate: string
  saving: boolean
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'save', input: FlightWatchInput): void
}>()

/** As on the server (MAX_COMBINATIONS in travel/flexible-dates.ts). */
const MAX_COMBINATIONS = 120

const TRIP_TYPES = [
  { label: 'Hin und zurück', value: 'round' },
  { label: 'Nur hin', value: 'oneway' },
]
const CLASSES = [
  { label: 'Economy', value: 1 },
  { label: 'Premium Economy', value: 2 },
  { label: 'Business', value: 3 },
  { label: 'First', value: 4 },
]
const STOPS = [
  { label: 'Beliebig', value: -1 },
  { label: 'Nur nonstop', value: 0 },
  { label: 'Höchstens 1 Umstieg', value: 1 },
  { label: 'Höchstens 2 Umstiege', value: 2 },
]
const AIRLINE_MODES = [
  { label: 'Nur diese', value: 'include' },
  { label: 'Alle außer diesen', value: 'exclude' },
]

const origin = ref('')
const destination = ref('')
const tripType = ref<FlightTripType>('round')
const flexible = ref(false)
const outbound = ref<Date | null>(null)
const ret = ref<Date | null>(null)
const from = ref<Date | null>(null)
const until = ref<Date | null>(null)
const minNights = ref<number | null>(5)
const maxNights = ref<number | null>(7)
const adults = ref<number | null>(1)
const children = ref<number | null>(0)
const infants = ref<number | null>(0)
const travelClass = ref(1)
const maxStops = ref(-1)
const airlines = ref('')
const airlinesMode = ref<AirlinesMode>('include')
const outFrom = ref<number | null>(null)
const outTo = ref<number | null>(null)
const retFrom = ref<number | null>(null)
const retTo = ref<number | null>(null)
const currency = ref('EUR')
const limit = ref<number | null>(null)
const endDate = ref<Date | null>(null)
const paused = ref(false)
const notifyPush = ref(true)
const notifyEmail = ref(true)
const checkedBag = ref(true)
const endTouched = ref(false)

const round = computed(() => tripType.value === 'round')
const tomorrow = computed(() => {
  const d = parseLocalDate(props.today)
  d.setDate(d.getDate() + 1)
  return d
})
const maxEnd = computed(() => parseLocalDate(props.maxEndDate))

function splitHours(v: string | null): [number | null, number | null] {
  if (!v) return [null, null]
  const [a, b] = v.split(',').map(Number)
  return [a ?? null, b ?? null]
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

const dayMs = 86_400_000
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / dayMs)

watch(
  () => props.visible,
  (open) => {
    if (!open) return
    const w = props.entry
    origin.value = w?.origin ?? ''
    destination.value = w?.destination ?? ''
    tripType.value = w?.trip_type ?? 'round'
    flexible.value = w?.flexible ?? false
    outbound.value = w?.outbound_date ? parseLocalDate(w.outbound_date) : null
    ret.value = w?.return_date ? parseLocalDate(w.return_date) : null
    from.value = w?.date_from ? parseLocalDate(w.date_from) : null
    until.value = w?.date_until ? parseLocalDate(w.date_until) : null
    minNights.value = w?.min_nights ?? 5
    maxNights.value = w?.max_nights ?? 7
    adults.value = w?.adults ?? 1
    children.value = w?.children ?? 0
    infants.value = w?.infants_on_lap ?? 0
    travelClass.value = w?.travel_class ?? 1
    maxStops.value = w?.max_stops ?? -1
    airlines.value = w?.airlines ?? ''
    airlinesMode.value = w?.airlines_mode ?? 'include'
    ;[outFrom.value, outTo.value] = splitHours(w?.outbound_times ?? null)
    ;[retFrom.value, retTo.value] = splitHours(w?.return_times ?? null)
    currency.value = w?.currency ?? 'EUR'
    limit.value = w?.limit_total ?? null
    endDate.value = w ? parseLocalDate(w.end_date) : null
    paused.value = w?.paused ?? false
    notifyPush.value = w?.notify_push ?? true
    notifyEmail.value = w?.notify_email ?? true
    checkedBag.value = w?.checked_bag ?? true
    endTouched.value = !!w
  },
  { immediate: true },
)

/** The flexible window's combinations, counted as the server does. */
const combinations = computed<number>(() => {
  if (!flexible.value || !from.value || !until.value) return 0
  let n = 0
  const first = from.value > tomorrow.value ? from.value : tomorrow.value
  for (let d = new Date(first); d <= until.value; d = addDays(d, 1)) {
    if (!round.value) {
      n++
      continue
    }
    const lo = minNights.value ?? 0
    const hi = maxNights.value ?? lo
    for (let k = lo; k <= hi; k++) {
      if (addDays(d, k) > until.value) break
      n++
    }
  }
  return n
})

/** The last day a flight can leave; the watch must end before it. */
const lastDeparture = computed<Date | null>(() => {
  if (!flexible.value) return outbound.value
  if (!until.value) return null
  return round.value ? addDays(until.value, -(minNights.value ?? 0)) : until.value
})

function defaultEnd(last: Date | null): Date | null {
  if (!last) return null
  const d = addDays(last, -1)
  return d > maxEnd.value ? new Date(maxEnd.value) : d
}

watch(lastDeparture, (last) => {
  if (!endTouched.value) endDate.value = defaultEnd(last)
})

watch(outbound, (o) => {
  if (o && ret.value && ret.value < o) ret.value = addDays(o, 7)
})

function hours(a: number | null, b: number | null): string | null {
  if (a === null && b === null) return null
  return `${a ?? 0},${b ?? 23}`
}

const passengers = computed(() => (adults.value ?? 0) + (children.value ?? 0) + (infants.value ?? 0))

const problem = computed<string | null>(() => {
  const code = /^[A-Za-z]{3}(\s*,\s*[A-Za-z]{3})*$/
  if (!code.test(origin.value.trim())) return 'Abflug: Flughafen-Codes wie FRA oder FRA,HHN'
  if (!code.test(destination.value.trim())) return 'Ziel: Flughafen-Codes wie JFK'
  if (!flexible.value) {
    if (!outbound.value) return 'Hinflug angeben'
    if (round.value && !ret.value) return 'Rückflug angeben'
    if (round.value && ret.value && outbound.value && ret.value < outbound.value) return 'Der Rückflug liegt vor dem Hinflug'
  } else {
    if (!from.value || !until.value) return 'Zeitraum angeben'
    if (until.value < from.value) return 'Der Zeitraum endet vor seinem Beginn'
    if (daysBetween(from.value, until.value) > 180) return 'Der Zeitraum darf höchstens 180 Tage lang sein'
    if (round.value && (minNights.value === null || maxNights.value === null || minNights.value > maxNights.value)) {
      return 'Dauer: Nächte von und bis angeben'
    }
    if (!combinations.value) return 'Im Zeitraum passt keine Reise'
    if (combinations.value > MAX_COMBINATIONS) return `Zu viele Kombinationen (${combinations.value}, höchstens ${MAX_COMBINATIONS})`
  }
  if (!adults.value || adults.value < 1) return 'Mindestens ein Erwachsener'
  if ((infants.value ?? 0) > (adults.value ?? 0)) return 'Höchstens ein Kleinkind je Erwachsenem'
  if (passengers.value > 9) return 'Höchstens 9 Reisende'
  if (!endDate.value) return 'Ende der Beobachtung angeben'
  if (endDate.value > maxEnd.value) return 'Das Ende darf höchstens zwei Jahre in der Zukunft liegen'
  if (lastDeparture.value && endDate.value >= lastDeparture.value) return 'Das Ende muss vor dem letzten möglichen Hinflug liegen'
  return null
})

function save() {
  if (problem.value || !endDate.value) return
  const iso = (d: Date | null) => (d ? toLocalIsoDate(d) : null)
  emit('save', {
    origin: origin.value.trim().toUpperCase(),
    destination: destination.value.trim().toUpperCase(),
    trip_type: tripType.value,
    flexible: flexible.value,
    outbound_date: flexible.value ? null : iso(outbound.value),
    return_date: flexible.value || !round.value ? null : iso(ret.value),
    date_from: flexible.value ? iso(from.value) : null,
    date_until: flexible.value ? iso(until.value) : null,
    min_nights: flexible.value && round.value ? minNights.value : null,
    max_nights: flexible.value && round.value ? maxNights.value : null,
    adults: adults.value ?? 1,
    children: children.value ?? 0,
    infants_on_lap: infants.value ?? 0,
    travel_class: travelClass.value,
    max_stops: maxStops.value < 0 ? null : maxStops.value,
    airlines: airlines.value.trim() || null,
    airlines_mode: airlines.value.trim() ? airlinesMode.value : null,
    outbound_times: hours(outFrom.value, outTo.value),
    return_times: round.value ? hours(retFrom.value, retTo.value) : null,
    currency: currency.value.trim().toUpperCase() || 'EUR',
    limit_total: limit.value,
    end_date: toLocalIsoDate(endDate.value),
    paused: paused.value,
    notify_push: notifyPush.value,
    notify_email: notifyEmail.value,
    checked_bag: checkedBag.value,
  })
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    :header="entry ? 'Wächter bearbeiten' : 'Neuer Flugpreis-Wächter'"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <form class="fw-form" @submit.prevent="save">
      <div class="field">
        <label for="fw-origin">Von (Flughafen-Code)</label>
        <InputText id="fw-origin" v-model="origin" placeholder="z. B. FRA oder FRA,HHN" autocomplete="off" autofocus />
      </div>
      <div class="field">
        <label for="fw-destination">Nach (Flughafen-Code)</label>
        <InputText id="fw-destination" v-model="destination" placeholder="z. B. JFK" autocomplete="off" />
      </div>

      <div class="field field-wide">
        <SelectButton
          v-model="tripType"
          :options="TRIP_TYPES"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-label="Reiseart"
        />
      </div>

      <div class="field field-wide field-check">
        <Checkbox v-model="flexible" input-id="fw-flex" binary />
        <label for="fw-flex">Flexibel bei Zeitpunkt{{ round ? ' und Dauer' : '' }}</label>
      </div>

      <template v-if="!flexible">
        <div class="field">
          <label for="fw-out">Hinflug</label>
          <DatePicker v-model="outbound" input-id="fw-out" date-format="dd.mm.yy" :min-date="tomorrow" show-icon />
        </div>
        <div v-if="round" class="field">
          <label for="fw-ret">Rückflug</label>
          <DatePicker v-model="ret" input-id="fw-ret" date-format="dd.mm.yy" :min-date="outbound ?? tomorrow" show-icon />
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label for="fw-from">Frühester Hinflug</label>
          <DatePicker v-model="from" input-id="fw-from" date-format="dd.mm.yy" :min-date="tomorrow" show-icon />
        </div>
        <div class="field">
          <label for="fw-until">{{ round ? 'Spätester Rückflug' : 'Spätester Hinflug' }}</label>
          <DatePicker v-model="until" input-id="fw-until" date-format="dd.mm.yy" :min-date="from ?? tomorrow" show-icon />
        </div>
        <template v-if="round">
          <div class="field">
            <label for="fw-min">Nächte von</label>
            <InputNumber v-model="minNights" input-id="fw-min" :min="0" :max="60" show-buttons />
          </div>
          <div class="field">
            <label for="fw-max">Nächte bis</label>
            <InputNumber v-model="maxNights" input-id="fw-max" :min="0" :max="60" show-buttons />
          </div>
        </template>
        <small class="field-wide muted">
          <template v-if="combinations">
            {{ combinations }} {{ combinations === 1 ? 'mögliche Reise' : 'mögliche Reisen' }} im Zeitraum. Geprüft wird eine je
            Tag, der Reihe nach; so kostet der Wächter nicht mehr Suchen als einer mit festen Daten. Ein Durchlauf dauert
            {{ combinations }} {{ combinations === 1 ? 'Tag' : 'Tage' }}, der Preis jeder Reise gilt bis zu ihrer nächsten Prüfung.
          </template>
          <template v-else>Wähle den Zeitraum, in dem du reisen kannst.</template>
        </small>
      </template>

      <div class="field">
        <label for="fw-adults">Erwachsene</label>
        <InputNumber v-model="adults" input-id="fw-adults" :min="1" :max="9" show-buttons />
      </div>
      <div class="field">
        <label for="fw-children">Kinder (2–11 Jahre)</label>
        <InputNumber v-model="children" input-id="fw-children" :min="0" :max="8" show-buttons />
      </div>
      <div class="field">
        <label for="fw-infants">Kleinkinder auf dem Schoß</label>
        <InputNumber v-model="infants" input-id="fw-infants" :min="0" :max="4" show-buttons />
      </div>
      <div class="field">
        <label for="fw-class">Klasse</label>
        <Select v-model="travelClass" input-id="fw-class" :options="CLASSES" option-label="label" option-value="value" />
      </div>

      <div class="field">
        <label for="fw-stops">Umstiege</label>
        <Select v-model="maxStops" input-id="fw-stops" :options="STOPS" option-label="label" option-value="value" />
      </div>
      <div class="field">
        <label for="fw-airlines">Airlines (Codes, optional)</label>
        <InputText id="fw-airlines" v-model="airlines" placeholder="z. B. LH,OS oder STAR_ALLIANCE" autocomplete="off" />
        <Select
          v-if="airlines.trim()"
          v-model="airlinesMode"
          :options="AIRLINE_MODES"
          option-label="label"
          option-value="value"
          aria-label="Airlines einschließen oder ausschließen"
        />
      </div>

      <fieldset class="field hours">
        <legend>Abflug hin zwischen (Uhr)</legend>
        <div class="hours-row">
          <InputNumber v-model="outFrom" :min="0" :max="23" placeholder="0" aria-label="Abflug hin frühestens um" />
          <span aria-hidden="true">–</span>
          <InputNumber v-model="outTo" :min="0" :max="23" placeholder="23" aria-label="Abflug hin spätestens um" />
        </div>
      </fieldset>
      <fieldset v-if="round" class="field hours">
        <legend>Abflug zurück zwischen (Uhr)</legend>
        <div class="hours-row">
          <InputNumber v-model="retFrom" :min="0" :max="23" placeholder="0" aria-label="Abflug zurück frühestens um" />
          <span aria-hidden="true">–</span>
          <InputNumber v-model="retTo" :min="0" :max="23" placeholder="23" aria-label="Abflug zurück spätestens um" />
        </div>
      </fieldset>

      <div class="field">
        <label for="fw-limit">Preisgrenze ({{ round ? 'hin und zurück, ' : '' }}alle Reisenden)</label>
        <InputNumber v-model="limit" input-id="fw-limit" :min="1" :max="1000000" placeholder="ohne Grenze" />
      </div>
      <div class="field">
        <label for="fw-currency">Währung</label>
        <InputText id="fw-currency" v-model="currency" maxlength="3" />
      </div>
      <div class="field field-wide">
        <div class="field-check">
          <Checkbox v-model="checkedBag" input-id="fw-bag" binary />
          <label for="fw-bag">Mindestens 1 Aufgabegepäck je Reisendem</label>
        </div>
        <small class="muted">
          Google Flights filtert nicht danach. Bevor der Wächter meldet, holt er die Anbieter und rechnet die Gebühr
          für den ersten Koffer ein; liegt der Preis dann über der Grenze, meldet er nicht.
        </small>
      </div>

      <fieldset class="field field-wide notify">
        <legend>Melden, wenn der Preis unter die Grenze fällt</legend>
        <div class="field-check">
          <Checkbox v-model="notifyPush" input-id="fw-push" binary :disabled="limit === null" />
          <label for="fw-push">Push-Benachrichtigung</label>
        </div>
        <div class="field-check">
          <Checkbox v-model="notifyEmail" input-id="fw-mail" binary :disabled="limit === null" />
          <label for="fw-mail">E-Mail</label>
        </div>
        <small class="muted">
          {{
            limit === null
              ? 'Ohne Grenze gibt es nichts zu melden.'
              : 'Einmal, und wieder bei einem neuen Tiefstpreis; mit der Meldung holt der Wächter, wer den Flug zu welchem Preis verkauft (ein bis zwei Suchen mehr).'
          }}
        </small>
      </fieldset>

      <div class="field">
        <label for="fw-end">Ende der Beobachtung</label>
        <DatePicker
          v-model="endDate"
          input-id="fw-end"
          date-format="dd.mm.yy"
          :min-date="parseLocalDate(today)"
          :max-date="maxEnd"
          show-icon
          @update:model-value="endTouched = true"
        />
        <small class="muted">Vor dem letzten möglichen Hinflug, höchstens zwei Jahre ab heute.</small>
      </div>
      <div v-if="entry" class="field field-check field-end">
        <Checkbox v-model="paused" input-id="fw-paused" binary />
        <label for="fw-paused">Pausiert</label>
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
.fw-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}
@media (max-width: 639px) {
  .fw-form {
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
.field label,
.field legend {
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
.hours,
.notify {
  border: 0;
  margin: 0;
  padding: 0;
}
.hours legend,
.notify legend {
  padding: 0;
  margin-bottom: var(--space-1);
}
.hours-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.hours-row :deep(.p-inputnumber) {
  flex: 1;
  min-width: 0;
}
.hours-row :deep(input) {
  width: 100%;
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
