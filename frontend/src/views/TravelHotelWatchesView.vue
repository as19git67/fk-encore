<script setup lang="ts">
/**
 * Reise › Hotelpreise: the hotel price watches of the user.
 *
 * Built like the history of the KI-Benchmark page: a table of the watches,
 * and below it the chosen watch — its prices of the last check as tiles,
 * the rates of that check, and the history of every check as a table.
 * The chosen watch lives in `route.query.watch`, so a reload or a shared
 * link opens the same one.
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
import HotelWatchDialog from '../components/travel/HotelWatchDialog.vue'
import {
  checkHotelWatch,
  createHotelWatch,
  deleteHotelWatch,
  getHotelSearchStatus,
  getHotelWatch,
  listHotelWatches,
  updateHotelWatch,
  type HotelSearchStatus,
  type HotelWatch,
  type HotelWatchDetail,
  type HotelWatchInput,
  type HotelWatchStatus,
} from '../api/travel'
import { parseLocalDate } from '../utils/dateFormat'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const confirm = useConfirm()
const auth = useAuthStore()

const canManage = computed(() => auth.hasPermission('travel.manage'))

const watches = ref<HotelWatch[]>([])
const status = ref<HotelSearchStatus | null>(null)
const detail = ref<HotelWatchDetail | null>(null)
const loaded = ref(false)
const error = ref<string | null>(null)
const info = ref<string | null>(null)
const checking = ref<number | null>(null)

const dialogOpen = ref(false)
const editing = ref<HotelWatch | null>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)

const STATUS: Record<HotelWatchStatus, { label: string; severity: 'success' | 'secondary' | 'warn' }> = {
  active: { label: 'Aktiv', severity: 'success' },
  paused: { label: 'Pausiert', severity: 'warn' },
  ended: { label: 'Beendet', severity: 'secondary' },
}

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

function day(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–'
}

function guests(w: HotelWatch): string {
  const kids = w.children_ages.length
  return `${w.adults} Erw.` + (kids ? `, ${kids} ${kids === 1 ? 'Kind' : 'Kinder'}` : '')
}

function conditions(w: HotelWatch): string {
  const parts = [w.free_cancellation_only ? 'stornierbar' : 'jeder Tarif']
  if (w.breakfast_required) parts.push('mit Frühstück')
  return parts.join(', ')
}

async function loadList() {
  try {
    const [list, st] = await Promise.all([listHotelWatches(), getHotelSearchStatus()])
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
    detail.value = await getHotelWatch(id)
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

function openEdit(w: HotelWatch) {
  editing.value = w
  saveError.value = null
  dialogOpen.value = true
}

async function save(input: HotelWatchInput) {
  saving.value = true
  saveError.value = null
  try {
    const { watch } = editing.value
      ? await updateHotelWatch(editing.value.id, input)
      : await createHotelWatch(input)
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

async function checkNow(w: HotelWatch) {
  checking.value = w.id
  error.value = null
  info.value = null
  try {
    const { check } = await checkHotelWatch(w.id)
    info.value = check.error
      ? `Geprüft, aber ohne Preise: ${check.error}`
      : `Geprüft: ${check.offer_count} Tarife, ${check.searches} ${check.searches === 1 ? 'Suche' : 'Suchen'} verbraucht.`
    await loadList()
    if (selectedId.value === w.id) await loadDetail()
    else select(w.id)
  } catch (e) {
    error.value = message(e, 'Die Prüfung ist fehlgeschlagen')
  } finally {
    checking.value = null
  }
}

function remove(w: HotelWatch) {
  confirm.require({
    message: `Den Wächter für „${w.hotel_name ?? w.query}“ (${day(w.check_in)} bis ${day(w.check_out)}) mit seinem ganzen Preisverlauf löschen?`,
    header: 'Wächter löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteHotelWatch(w.id)
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
</script>

<template>
  <PageLayout
    title="Hotelpreise"
    hint="Beobachtet die Preise einzelner Hotels für feste Daten über Google Hotels und schreibt bei jeder Prüfung den Verlauf. Jeder Wächter endet spätestens zwei Jahre nach heute."
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

    <div class="hotels">
      <PageSkeleton v-if="!loaded" variant="list" :count="3" />

      <template v-else>
        <section class="card" aria-labelledby="hotels-list">
          <header class="card-head">
            <h2 id="hotels-list" class="card-title">Wächter</h2>
            <span v-if="status" class="muted">
              {{ status.searches_this_month }} / {{ status.monthly_budget }} Suchen in diesem Monat ·
              Prüfung täglich um {{ status.check_time }} Uhr
            </span>
          </header>
          <EmptyState
            v-if="!watches.length"
            icon="pi pi-building"
            title="Noch kein Wächter"
            message="Lege einen Wächter für ein Hotel und deine Reisedaten an. Er prüft den Preis regelmäßig bis zum Ende, das du festlegst."
          />
          <ScrollX v-else>
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Hotel</th>
                  <th scope="col">Zeitraum</th>
                  <th scope="col">Gäste</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num">Grenze</th>
                  <th scope="col" class="num">Aktuell</th>
                  <th scope="col" class="num">Bisher bester</th>
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
                  <td class="hotel">
                    <button type="button" class="link" @click="select(w.id)">{{ w.hotel_name ?? w.query }}</button>
                    <span class="muted block">{{ conditions(w) }} · bis {{ day(w.end_date) }}</span>
                  </td>
                  <td class="num">{{ day(w.check_in) }} – {{ day(w.check_out) }}</td>
                  <td>{{ guests(w) }}</td>
                  <td><Tag :value="STATUS[w.status].label" :severity="STATUS[w.status].severity" /></td>
                  <td class="num">{{ money(w.limit_per_night, w.currency) }}</td>
                  <td :class="['num', { 'below-limit': w.latest?.below_limit }]">
                    {{ money(w.latest?.matching_per_night, w.currency) }}
                  </td>
                  <td class="num">{{ money(w.best_matching_per_night, w.currency) }}</td>
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
                        :aria-label="`Preis für ${w.hotel_name ?? w.query} jetzt prüfen`"
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
                        :aria-label="`Wächter für ${w.hotel_name ?? w.query} bearbeiten`"
                        :disabled="w.status === 'ended'"
                        @click="openEdit(w)"
                      />
                      <Button
                        icon="pi pi-trash"
                        text
                        rounded
                        severity="secondary"
                        size="small"
                        :aria-label="`Wächter für ${w.hotel_name ?? w.query} löschen`"
                        @click="remove(w)"
                      />
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </section>

        <section v-if="selected" class="card" aria-labelledby="hotels-prices">
          <header class="card-head">
            <h2 id="hotels-prices" class="card-title">{{ selected.hotel_name ?? selected.query }}</h2>
            <span class="muted">
              {{ day(selected.check_in) }} – {{ day(selected.check_out) }} · {{ selected.nights }}
              {{ selected.nights === 1 ? 'Nacht' : 'Nächte' }} · {{ guests(selected) }}
            </span>
          </header>
          <p v-if="!latest" class="muted">Noch keine erfolgreiche Prüfung.</p>
          <template v-else>
            <p class="muted">
              Stand {{ when(latest.checked_at) }}. Preise pro Nacht inklusive Steuern; eine Resort- oder
              Destination-Fee, die das Hotel vor Ort verlangt, ist nicht enthalten.
            </p>
            <dl class="tiles">
              <div :class="['tile', { 'tile--hit': latest.below_limit }]">
                <dt>Passend ({{ conditions(selected) }})</dt>
                <dd>{{ money(latest.matching_per_night, selected.currency) }}</dd>
              </div>
              <div class="tile"><dt>Günstigster Tarif</dt><dd>{{ money(latest.lowest_per_night, selected.currency) }}</dd></div>
              <div class="tile"><dt>Stornierbar</dt><dd>{{ money(latest.lowest_free_per_night, selected.currency) }}</dd></div>
              <div class="tile">
                <dt>Stornierbar mit Frühstück</dt>
                <dd>{{ money(latest.lowest_free_breakfast_per_night, selected.currency) }}</dd>
              </div>
              <div class="tile"><dt>Grenze</dt><dd>{{ money(selected.limit_per_night, selected.currency) }}</dd></div>
              <div class="tile"><dt>Bisher bester</dt><dd>{{ money(selected.best_matching_per_night, selected.currency) }}</dd></div>
            </dl>

            <h3 class="sub-title">Tarife der letzten Prüfung</h3>
            <ScrollX>
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">Anbieter</th>
                    <th scope="col">Zimmer</th>
                    <th scope="col" class="num">pro Nacht</th>
                    <th scope="col" class="num">gesamt</th>
                    <th scope="col">Storno</th>
                    <th scope="col">Frühstück</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(o, i) in detail?.offers ?? []" :key="i">
                    <td>{{ o.source }}</td>
                    <td class="room">{{ o.room }}</td>
                    <td class="num">{{ money(o.per_night, selected.currency) }}</td>
                    <td class="num">{{ money(o.total, selected.currency) }}</td>
                    <td>{{ o.free_cancellation ? `kostenlos${o.cancel_until ? ' bis ' + o.cancel_until : ''}` : 'nein' }}</td>
                    <td>{{ o.breakfast ? 'ja' : '–' }}</td>
                  </tr>
                </tbody>
              </table>
            </ScrollX>
          </template>
        </section>

        <section v-if="selected" class="card" aria-labelledby="hotels-history">
          <h2 id="hotels-history" class="card-title">Verlauf</h2>
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
                  <th scope="col" class="num">Passend</th>
                  <th scope="col">Anbieter</th>
                  <th scope="col" class="num">Günstigster</th>
                  <th scope="col" class="num">Stornierbar</th>
                  <th scope="col" class="num">mit Frühstück</th>
                  <th scope="col" class="num">Tarife</th>
                  <th scope="col" class="num">Suchen</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in detail.checks" :key="c.id">
                  <td>{{ when(c.checked_at) }}</td>
                  <template v-if="c.error">
                    <td colspan="5" class="failure">{{ c.error }}</td>
                  </template>
                  <template v-else>
                    <td :class="['num', { 'below-limit': c.below_limit }]">{{ money(c.matching_per_night, selected.currency) }}</td>
                    <td>{{ c.matching_source ?? '–' }}</td>
                    <td class="num">{{ money(c.lowest_per_night, selected.currency) }}</td>
                    <td class="num">{{ money(c.lowest_free_per_night, selected.currency) }}</td>
                    <td class="num">{{ money(c.lowest_free_breakfast_per_night, selected.currency) }}</td>
                  </template>
                  <td class="num">{{ c.offer_count }}</td>
                  <td class="num">{{ c.searches }}</td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
        </section>
      </template>
    </div>

    <HotelWatchDialog
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
.hotels {
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
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
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
/* Wide enough to read on a phone; ScrollX scrolls the rest. */
.hotel {
  min-width: 12rem;
}
.room {
  min-width: 12rem;
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
