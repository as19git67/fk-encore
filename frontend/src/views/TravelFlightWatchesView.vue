<script setup lang="ts">
/**
 * Reise › Flugpreise: the flight price watches of the user.
 *
 * Laid out like Reise › Hotelpreise: a table of the watches, and below it
 * the chosen watch — the best price it knows and Google's assessment as
 * tiles, Google's price history of the dates, the flights of the last
 * check, who sold the cheapest one at the last report, the date
 * combinations of a flexible watch and the history of every check.
 * The chosen watch lives in `route.query.watch`.
 */
import { computed, onMounted, ref, watch as watchRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useConfirm } from 'primevue/useconfirm'
import PageLayout from '../components/layout/PageLayout.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import PageSkeleton from '../components/layout/PageSkeleton.vue'
import ScrollX from '../components/layout/ScrollX.vue'
import FlightWatchDialog from '../components/travel/FlightWatchDialog.vue'
import {
  checkFlightWatch,
  createFlightWatch,
  deleteFlightWatch,
  getFlightWatch,
  getHotelSearchStatus,
  listFlightWatches,
  updateFlightWatch,
  type FlightWatch,
  type FlightWatchDetail,
  type FlightWatchInput,
  type HotelSearchStatus,
  type HotelWatchStatus,
} from '../api/travel'
import { parseLocalDate } from '../utils/dateFormat'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const auth = useAuthStore()

const canManage = computed(() => auth.hasPermission('travel.manage'))

const watches = ref<FlightWatch[]>([])
const status = ref<HotelSearchStatus | null>(null)
const detail = ref<FlightWatchDetail | null>(null)
const loaded = ref(false)
const error = ref<string | null>(null)
const info = ref<string | null>(null)
const checking = ref<number | null>(null)

const dialogOpen = ref(false)
const editing = ref<FlightWatch | null>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)

const STATUS: Record<HotelWatchStatus, { label: string; severity: 'success' | 'secondary' | 'warn' }> = {
  active: { label: 'Aktiv', severity: 'success' },
  paused: { label: 'Pausiert', severity: 'warn' },
  ended: { label: 'Beendet', severity: 'secondary' },
}

const LEVEL: Record<string, { label: string; severity: 'success' | 'secondary' | 'danger' }> = {
  low: { label: 'günstig', severity: 'success' },
  typical: { label: 'üblich', severity: 'secondary' },
  high: { label: 'teuer', severity: 'danger' },
}

const CLASS_LABEL: Record<number, string> = { 1: 'Economy', 2: 'Premium Economy', 3: 'Business', 4: 'First' }

const selectedId = computed<number | null>(() => {
  const raw = Number(route.query.watch)
  return Number.isInteger(raw) && raw > 0 ? raw : null
})

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

function money(v: number | null | undefined, currency = 'EUR'): string {
  if (v === null || v === undefined) return '–'
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v)
}

function day(iso: string | null): string {
  return iso ? parseLocalDate(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–'
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–'
}

/** "2027-05-01 07:05" → "01.05. 07:05". */
function clock(local: string | null): string {
  if (!local) return '–'
  const [d, t] = local.split(' ')
  const [, m, dd] = (d ?? '').split('-')
  return `${dd}.${m}. ${t ?? ''}`.trim()
}

function duration(min: number | null): string {
  if (min === null) return '–'
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
}

function stops(n: number | null): string {
  if (n === null) return '–'
  return n === 0 ? 'nonstop' : n === 1 ? '1 Umstieg' : `${n} Umstiege`
}

function route_(w: FlightWatch): string {
  return `${w.origin.split(',').join('/')} → ${w.destination.split(',').join('/')}`
}

function dates(outbound: string | null, ret: string | null): string {
  return ret ? `${day(outbound)} – ${day(ret)}` : `${day(outbound)}, einfach`
}

function when_(w: FlightWatch): string {
  if (!w.flexible) return dates(w.outbound_date, w.return_date)
  const span = `${day(w.date_from)} bis ${day(w.date_until)}`
  return w.trip_type === 'round' ? `${span}, ${w.min_nights}–${w.max_nights} Nächte` : `${span}, einfach`
}

function travellers(w: FlightWatch): string {
  const parts = [`${w.adults} Erw.`]
  if (w.children) parts.push(`${w.children} ${w.children === 1 ? 'Kind' : 'Kinder'}`)
  if (w.infants_on_lap) parts.push(`${w.infants_on_lap} Kleinkind${w.infants_on_lap === 1 ? '' : 'er'}`)
  return parts.join(', ')
}

function conditions(w: FlightWatch): string {
  const parts = [CLASS_LABEL[w.travel_class] ?? 'Economy']
  if (w.max_stops !== null) parts.push(w.max_stops === 0 ? 'nonstop' : `max. ${w.max_stops} Umstieg${w.max_stops === 1 ? '' : 'e'}`)
  if (w.airlines) parts.push(`${w.airlines_mode === 'exclude' ? 'ohne' : 'nur'} ${w.airlines}`)
  if (w.outbound_times) parts.push(`hin ${w.outbound_times.replace(',', '–')} Uhr`)
  if (w.return_times) parts.push(`zurück ${w.return_times.replace(',', '–')} Uhr`)
  if (w.checked_bag) parts.push('mit Koffer')
  if (w.flexible) parts.push('flexibel')
  return parts.join(', ')
}

function reporting(w: FlightWatch): string {
  const ways = [w.notify_push ? 'Push' : null, w.notify_email ? 'Mail' : null].filter(Boolean)
  return ways.length ? `Meldung per ${ways.join(' und ')}` : 'ohne Meldung'
}

async function loadList() {
  try {
    const [list, st] = await Promise.all([listFlightWatches(), getHotelSearchStatus()])
    watches.value = list.watches
    status.value = st
  } catch (e) {
    error.value = message(e, 'Die Wächter konnten nicht geladen werden')
  } finally {
    loaded.value = true
  }
}

async function loadDetail() {
  const id = selectedId.value
  if (!id) {
    detail.value = null
    return
  }
  try {
    detail.value = await getFlightWatch(id)
  } catch (e) {
    detail.value = null
    error.value = message(e, 'Der Wächter konnte nicht geladen werden')
  }
}

function select(id: number | null) {
  const query = { ...route.query }
  if (id) query.watch = String(id)
  else delete query.watch
  void router.replace({ query })
}

watchRef(selectedId, loadDetail)

onMounted(async () => {
  await loadList()
  const first = watches.value[0]
  if (!selectedId.value && first) select(first.id)
  else await loadDetail()
})

function openCreate() {
  editing.value = null
  saveError.value = null
  dialogOpen.value = true
}

function openEdit(w: FlightWatch) {
  editing.value = w
  saveError.value = null
  dialogOpen.value = true
}

async function save(input: FlightWatchInput) {
  saving.value = true
  saveError.value = null
  try {
    const { watch } = editing.value ? await updateFlightWatch(editing.value.id, input) : await createFlightWatch(input)
    dialogOpen.value = false
    await loadList()
    if (selectedId.value === watch.id) await loadDetail()
    else select(watch.id)
  } catch (e) {
    saveError.value = message(e, 'Speichern fehlgeschlagen')
  } finally {
    saving.value = false
  }
}

async function checkNow(w: FlightWatch) {
  checking.value = w.id
  error.value = null
  info.value = null
  try {
    const { check } = await checkFlightWatch(w.id)
    info.value = check.error
      ? `Geprüft, aber ohne Preise: ${check.error}`
      : `Geprüft (${dates(check.outbound_date, check.return_date)}): ${check.flight_count} Flüge, ${check.searches} ${check.searches === 1 ? 'Suche' : 'Suchen'} verbraucht.`
    await loadList()
    if (selectedId.value === w.id) await loadDetail()
    else select(w.id)
  } catch (e) {
    error.value = message(e, 'Die Prüfung ist fehlgeschlagen')
  } finally {
    checking.value = null
  }
}

function remove(w: FlightWatch) {
  confirm.require({
    message: `Den Wächter für ${route_(w)} (${when_(w)}) mit seinem ganzen Preisverlauf löschen?`,
    header: 'Wächter löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteFlightWatch(w.id)
        if (selectedId.value === w.id) select(null)
        await loadList()
      } catch (e) {
        error.value = message(e, 'Der Wächter konnte nicht gelöscht werden')
      }
    },
  })
}

const selected = computed(() => detail.value?.watch ?? null)
const latest = computed(() => selected.value?.latest ?? null)

/** Google's price history as a line: x by day, y by price, with the limit if it is in range. */
const chart = computed(() => {
  const points = detail.value?.history?.points ?? []
  if (points.length < 2) return null
  const w = 600
  const h = 120
  const pad = 6
  const prices = points.map((p) => p.price)
  const limit = selected.value?.limit_total ?? null
  const lo = Math.min(...prices, ...(limit !== null ? [limit] : []))
  const hi = Math.max(...prices, ...(limit !== null ? [limit] : []))
  const span = hi - lo || 1
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - 2 * pad)
  const y = (v: number) => pad + (1 - (v - lo) / span) * (h - 2 * pad)
  return {
    w,
    h,
    line: points.map((p, i) => `${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' '),
    limitY: limit !== null ? y(limit) : null,
    first: points[0]!,
    last: points[points.length - 1]!,
    min: Math.min(...prices),
    max: Math.max(...prices),
  }
})
</script>

<template>
  <PageLayout
    title="Flugpreise"
    hint="Beobachtet Flugpreise über Google Flights, für feste Daten oder flexibel in einem Zeitraum, und schreibt bei jeder Prüfung den Verlauf. Jeder Wächter endet spätestens zwei Jahre nach heute."
    width="wide"
    :ready="loaded"
  >
    <template #actions>
      <Button v-if="canManage" icon="pi pi-plus" label="Neuer Wächter" @click="openCreate" />
    </template>

    <template #notice>
      <Message v-if="status && !status.configured" severity="warn" :closable="false">
        Es ist kein SerpApi-Schlüssel eingerichtet (<code>SERPAPI_API_KEY</code>). Wächter lassen sich anlegen,
        geprüft wird aber erst mit Schlüssel.
      </Message>
      <Message v-if="info" severity="success" closable @close="info = null">{{ info }}</Message>
      <ErrorBanner v-if="error" :message="error" :retryable="false" closable @close="error = null" />
    </template>

    <div class="flights">
      <PageSkeleton v-if="!loaded" variant="list" :count="3" />

      <template v-else>
        <section class="card" aria-labelledby="flights-list">
          <header class="card-head">
            <h2 id="flights-list" class="card-title">Wächter</h2>
            <span v-if="status" class="muted">
              {{ status.searches_this_month }} / {{ status.monthly_budget }} Suchen in diesem Monat (mit Hotels) ·
              Prüfung täglich um 06:15 Uhr
            </span>
          </header>
          <EmptyState
            v-if="!watches.length"
            icon="pi pi-send"
            title="Noch kein Wächter"
            message="Lege einen Wächter für eine Flugstrecke an, mit festen Daten oder flexibel in einem Zeitraum. Er prüft den Preis täglich bis zum Ende, das du festlegst."
          />
          <ScrollX v-else>
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Strecke</th>
                  <th scope="col">Reisedaten</th>
                  <th scope="col">Reisende</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num">Grenze</th>
                  <th scope="col" class="num">Bester Preis</th>
                  <th scope="col">Zuletzt geprüft</th>
                  <th scope="col"><span class="sr-only">Aktionen</span></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="w in watches"
                  :key="w.id"
                  :class="{ 'row-selected': selectedId === w.id }"
                  :aria-current="selectedId === w.id ? 'true' : undefined"
                >
                  <td class="route">
                    <button type="button" class="link" @click="select(w.id)">{{ route_(w) }}</button>
                    <span class="muted block">{{ conditions(w) }} · bis {{ day(w.end_date) }}</span>
                  </td>
                  <td class="dates">{{ when_(w) }}</td>
                  <td>{{ travellers(w) }}</td>
                  <td><Tag :value="STATUS[w.status].label" :severity="STATUS[w.status].severity" /></td>
                  <td class="num">{{ money(w.limit_total, w.currency) }}</td>
                  <td :class="['num', { 'below-limit': w.best && w.limit_total !== null && w.best.price < w.limit_total }]">
                    {{ money(w.best?.price, w.currency) }}
                    <small v-if="w.best?.with_bag" class="muted block">inkl. Koffer</small>
                    <small v-if="w.flexible && w.best" class="muted block">{{ dates(w.best.outbound_date, w.best.return_date) }}</small>
                  </td>
                  <td>
                    {{ when(w.last_checked_at) }}
                    <span v-if="w.last_error" class="failure block">{{ w.last_error }}</span>
                  </td>
                  <td class="actions">
                    <template v-if="canManage">
                      <Button
                        icon="pi pi-refresh"
                        text
                        rounded
                        severity="secondary"
                        size="small"
                        :aria-label="`Preis für ${route_(w)} jetzt prüfen`"
                        :disabled="w.status === 'ended' || !status?.configured"
                        :loading="checking === w.id"
                        @click="checkNow(w)"
                      />
                      <Button
                        icon="pi pi-pencil"
                        text
                        rounded
                        severity="secondary"
                        size="small"
                        :aria-label="`Wächter für ${route_(w)} bearbeiten`"
                        :disabled="w.status === 'ended'"
                        @click="openEdit(w)"
                      />
                      <Button
                        icon="pi pi-trash"
                        text
                        rounded
                        severity="secondary"
                        size="small"
                        :aria-label="`Wächter für ${route_(w)} löschen`"
                        @click="remove(w)"
                      />
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </section>

        <section v-if="selected" class="card" aria-labelledby="flights-prices">
          <header class="card-head">
            <h2 id="flights-prices" class="card-title">{{ route_(selected) }}</h2>
            <span class="muted">{{ when_(selected) }} · {{ travellers(selected) }}</span>
          </header>
          <p v-if="!latest" class="muted">Noch keine erfolgreiche Prüfung.</p>
          <template v-else>
            <p class="muted">
              Stand {{ when(latest.checked_at) }}, geprüft für {{ dates(latest.outbound_date, latest.return_date) }}.
              Preise für alle Reisenden{{ selected.trip_type === 'round' ? ', hin und zurück' : '' }}, ohne aufgegebenes Gepäck.
              <template v-if="selected.flexible">
                Flexibel: {{ selected.combinations }} mögliche Reisen, eine je Tag geprüft; der beste Preis ist der günstigste der
                zuletzt gefundenen.
              </template>
              {{ selected.limit_total !== null ? reporting(selected) + ', sobald der Preis unter die Grenze fällt.' : '' }}
              <template v-if="selected.notified_price !== null">
                Zuletzt gemeldet: {{ money(selected.notified_price, selected.currency) }}.
              </template>
            </p>
            <dl class="tiles">
              <div
                :class="['tile', { 'tile--hit': selected.best && selected.limit_total !== null && selected.best.price < selected.limit_total }]"
              >
                <dt>Bester Preis</dt>
                <dd>{{ money(selected.best?.price, selected.currency) }}</dd>
                <dd v-if="selected.best" class="tile-note">
                  {{ dates(selected.best.outbound_date, selected.best.return_date) }}, {{ stops(selected.best.stops) }}
                </dd>
                <dd v-if="selected.best?.with_bag" class="tile-note">inklusive Aufgabegepäck</dd>
              </div>
              <div class="tile">
                <dt>Letzte Prüfung</dt>
                <dd>{{ money(latest.lowest_price, selected.currency) }}</dd>
                <dd class="tile-note">{{ latest.lowest_airlines ?? '–' }}</dd>
              </div>
              <div class="tile">
                <dt>Laut Google</dt>
                <dd>
                  <Tag
                    v-if="latest.price_level && LEVEL[latest.price_level]"
                    :value="LEVEL[latest.price_level]!.label"
                    :severity="LEVEL[latest.price_level]!.severity"
                  />
                  <template v-else>–</template>
                </dd>
                <dd v-if="latest.typical_low !== null" class="tile-note">
                  üblich {{ money(latest.typical_low, selected.currency) }}–{{ money(latest.typical_high, selected.currency) }}
                </dd>
              </div>
              <div class="tile"><dt>Grenze</dt><dd>{{ money(selected.limit_total, selected.currency) }}</dd></div>
            </dl>
            <p v-if="selected.link">
              <a :href="selected.best?.link ?? selected.link" target="_blank" rel="noopener noreferrer">
                In Google Flights öffnen <i class="pi pi-external-link" aria-hidden="true" />
              </a>
            </p>

            <template v-if="chart">
              <h3 class="sub-title">
                Preisverlauf laut Google ({{ dates(detail!.history!.outbound_date, detail!.history!.return_date) }})
              </h3>
              <figure class="chart">
                <svg
                  :viewBox="`0 0 ${chart.w} ${chart.h}`"
                  preserveAspectRatio="none"
                  role="img"
                  :aria-label="`Preis von ${money(chart.first.price, selected.currency)} am ${day(chart.first.day)} bis ${money(chart.last.price, selected.currency)} am ${day(chart.last.day)}, zwischen ${money(chart.min, selected.currency)} und ${money(chart.max, selected.currency)}`"
                >
                  <line
                    v-if="chart.limitY !== null"
                    class="chart-limit"
                    x1="0"
                    :x2="chart.w"
                    :y1="chart.limitY"
                    :y2="chart.limitY"
                  />
                  <polyline class="chart-line" :points="chart.line" />
                </svg>
                <figcaption class="muted chart-axis">
                  <span>{{ day(chart.first.day) }} · {{ money(chart.first.price, selected.currency) }}</span>
                  <span>tief {{ money(chart.min, selected.currency) }} · hoch {{ money(chart.max, selected.currency) }}</span>
                  <span>{{ day(chart.last.day) }} · {{ money(chart.last.price, selected.currency) }}</span>
                </figcaption>
              </figure>
            </template>

            <h3 class="sub-title">Flüge der letzten Prüfung</h3>
            <ScrollX>
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col" class="num">Preis</th>
                    <th scope="col">Airline</th>
                    <th scope="col">Ab</th>
                    <th scope="col">An</th>
                    <th scope="col">Dauer</th>
                    <th scope="col">Umstiege</th>
                    <th scope="col">Flüge</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(o, i) in detail?.offers ?? []" :key="i">
                    <td class="num">
                      {{ money(o.price, selected.currency) }}
                      <small v-if="o.best" class="muted block">von Google empfohlen</small>
                    </td>
                    <td>{{ o.airlines }}</td>
                    <td class="num">{{ clock(o.departs_at) }}</td>
                    <td class="num">{{ clock(o.arrives_at) }}</td>
                    <td class="num">{{ duration(o.duration_min) }}</td>
                    <td>
                      {{ stops(o.stops) }}
                      <small v-if="o.layovers" class="muted block">über {{ o.layovers }}</small>
                    </td>
                    <td class="muted">{{ o.flight_numbers }}</td>
                  </tr>
                </tbody>
              </table>
            </ScrollX>
            <p v-if="selected.trip_type === 'round'" class="muted">
              Gezeigt sind die Hinflüge; ihr Preis gilt mit dem günstigsten passenden Rückflug.
            </p>

            <template v-if="detail?.bookings">
              <h3 class="sub-title">
                Angebote bei der letzten Meldung ({{ when(detail.bookings.checked_at) }},
                {{ dates(detail.bookings.outbound_date, detail.bookings.return_date) }})
              </h3>
              <ScrollX>
                <table class="table">
                  <thead>
                    <tr>
                      <th scope="col">Anbieter</th>
                      <th scope="col" class="num">Preis</th>
                      <th scope="col">Tarif</th>
                      <th scope="col">Bedingungen</th>
                      <th scope="col">Gepäck</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(b, i) in detail.bookings.options" :key="i">
                      <td>{{ b.book_with }}</td>
                      <td class="num">{{ money(b.price, selected.currency) }}</td>
                      <td>{{ b.option_title ?? '–' }}</td>
                      <td class="muted">{{ b.extensions || '–' }}</td>
                      <td class="muted">{{ b.baggage || '–' }}</td>
                    </tr>
                  </tbody>
                </table>
              </ScrollX>
            </template>
          </template>
        </section>

        <section v-if="selected?.flexible && detail?.combinations.length" class="card" aria-labelledby="flights-combos">
          <h2 id="flights-combos" class="card-title">Mögliche Reisen</h2>
          <p class="muted">Jede Reise im Zeitraum mit dem Preis ihrer letzten Prüfung. Noch nicht geprüfte kommen der Reihe nach dran.</p>
          <ScrollX>
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Hinflug</th>
                  <th v-if="selected.trip_type === 'round'" scope="col">Rückflug</th>
                  <th scope="col" class="num">Preis</th>
                  <th scope="col">Google</th>
                  <th scope="col">Geprüft</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="c in detail.combinations"
                  :key="`${c.outbound_date}|${c.return_date}`"
                  :class="{ 'row-selected': selected.best?.outbound_date === c.outbound_date && selected.best?.return_date === c.return_date }"
                >
                  <td class="num">
                    <a :href="c.link" target="_blank" rel="noopener noreferrer">{{ day(c.outbound_date) }}</a>
                  </td>
                  <td v-if="selected.trip_type === 'round'" class="num">{{ day(c.return_date) }}</td>
                  <td :class="['num', { 'below-limit': c.price !== null && selected.limit_total !== null && c.price < selected.limit_total }]">
                    {{ money(c.price, selected.currency) }}
                  </td>
                  <td>{{ c.price_level && LEVEL[c.price_level] ? LEVEL[c.price_level]!.label : '–' }}</td>
                  <td>{{ c.checked_at ? when(c.checked_at) : 'noch nicht' }}</td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </section>

        <section v-if="selected" class="card" aria-labelledby="flights-history">
          <h2 id="flights-history" class="card-title">Verlauf</h2>
          <EmptyState
            v-if="!detail?.checks.length"
            icon="pi pi-chart-line"
            title="Noch keine Prüfung"
            message="Die erste Prüfung erscheint hier, sobald der Job gelaufen ist oder du „Jetzt prüfen“ wählst."
          />
          <ScrollX v-else>
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Geprüft</th>
                  <th scope="col">Reisedaten</th>
                  <th scope="col" class="num">Günstigster</th>
                  <th scope="col">Airline</th>
                  <th scope="col">Google</th>
                  <th scope="col" class="num">Flüge</th>
                  <th scope="col" class="num">Suchen</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in detail.checks" :key="c.id">
                  <td>{{ when(c.checked_at) }}</td>
                  <td class="num">{{ dates(c.outbound_date, c.return_date) }}</td>
                  <template v-if="c.error">
                    <td colspan="3" class="failure">{{ c.error }}</td>
                  </template>
                  <template v-else>
                    <td :class="['num', { 'below-limit': c.below_limit }]">
                      {{ money(c.lowest_price, selected.currency) }}
                      <small v-if="c.bag_price !== null" class="muted block">mit Koffer {{ money(c.bag_price, selected.currency) }}</small>
                    </td>
                    <td>{{ c.lowest_airlines ?? '–' }}</td>
                    <td>{{ c.price_level && LEVEL[c.price_level] ? LEVEL[c.price_level]!.label : '–' }}</td>
                  </template>
                  <td class="num">{{ c.flight_count }}</td>
                  <td class="num">{{ c.searches }}</td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </section>
      </template>
    </div>

    <FlightWatchDialog
      v-if="status"
      v-model:visible="dialogOpen"
      :entry="editing"
      :today="status.today"
      :max-end-date="status.max_end_date"
      :saving="saving"
      :error="saveError"
      @save="save"
    />
  </PageLayout>
</template>

<style scoped>
.flights {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.card-title {
  margin: 0;
  font-size: var(--text-lg);
}
.sub-title {
  margin: 0;
  font-size: var(--text-md);
}
.muted {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.block {
  display: block;
}
.failure {
  margin: 0;
  color: var(--p-red-600);
  font-size: var(--text-sm);
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: var(--space-2);
  margin: 0;
}
.tile {
  padding: var(--space-2) var(--space-3);
  border-radius: 0.5rem;
  background: var(--p-content-hover-background);
}
.tile--hit {
  outline: 2px solid var(--p-primary-color);
}
.tile dt {
  font-size: var(--text-xs);
  color: var(--p-text-muted-color);
}
.tile dd {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}
.tile .tile-note {
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--p-text-muted-color);
}
.chart {
  margin: 0;
}
.chart svg {
  display: block;
  width: 100%;
  height: 7.5rem;
}
.chart-line {
  fill: none;
  stroke: var(--p-primary-color);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.chart-limit {
  stroke: var(--p-text-muted-color);
  stroke-width: 1;
  stroke-dasharray: 4 4;
  vector-effect: non-scaling-stroke;
}
.chart-axis {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.table th,
.table td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  text-align: left;
  vertical-align: top;
}
.table th {
  color: var(--p-text-muted-color);
  font-weight: 600;
}
.num {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.below-limit {
  color: var(--p-primary-color);
  font-weight: 600;
}
.actions {
  white-space: nowrap;
}
.route {
  min-width: 12rem;
}
.dates {
  min-width: 10rem;
}
.row-selected {
  background: var(--p-content-hover-background);
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--p-primary-color);
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.link:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
