<script setup lang="ts">
/**
 * Home location of the household + "fetch degree days" (#1023 follow-up).
 *
 * The weather-adjusted heating report needs degree days for the place the
 * house stands. Instead of importing a table, pick the town once (Open-Meteo
 * place search — a town is all the reanalysis resolves, and all that leaves
 * the house); the daily job then fills every missing month from the archive.
 * Coordinates can also be typed in when the place search is unreachable.
 */
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import {
  getMeterHomeLocation,
  setMeterHomeLocation,
  deleteMeterHomeLocation,
  searchMeterPlaces,
  fetchDegreeDays,
  type MeterHomeLocation,
  type PlaceCandidate,
} from '../api/meters'
import { decimalInputPt } from '../utils/inputNumberPt'

const props = defineProps<{
  canManage: boolean
}>()

const emit = defineEmits<{
  (e: 'degree-days-changed'): void
}>()

const home = ref<MeterHomeLocation | null>(null)
const loading = ref(false)
const error = ref('')
const info = ref('')

const query = ref('')
const searching = ref(false)
const candidates = ref<PlaceCandidate[]>([])
const searched = ref(false)

const manualMode = ref(false)
const manual = ref<{ label: string; lat: number | null; lon: number | null }>({ label: '', lat: null, lon: null })

const saving = ref(false)
const fetching = ref(false)

const canFetch = computed(() => props.canManage && home.value !== null)

function fmtCoord(value: number) {
  return value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function candidateLabel(place: PlaceCandidate) {
  return [place.name, place.admin1, place.country].filter(Boolean).join(', ')
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    home.value = (await getMeterHomeLocation()).home
  } catch (err: any) {
    error.value = err?.message || 'Wohnort konnte nicht geladen werden'
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function search() {
  const q = query.value.trim()
  if (q.length < 2) return
  searching.value = true
  error.value = ''
  candidates.value = []
  try {
    candidates.value = (await searchMeterPlaces(q)).places
    searched.value = true
  } catch (err: any) {
    error.value = err?.message || 'Ortssuche nicht erreichbar — Koordinaten können auch direkt eingegeben werden.'
    manualMode.value = true
  } finally {
    searching.value = false
  }
}

async function choose(place: PlaceCandidate) {
  saving.value = true
  error.value = ''
  try {
    home.value = (await setMeterHomeLocation({
      label: candidateLabel(place),
      lat: place.lat,
      lon: place.lon,
      source: 'geocoded',
    })).home
    candidates.value = []
    query.value = ''
    searched.value = false
    info.value = 'Wohnort gespeichert. Gradtagzahlen werden ab jetzt täglich ergänzt — oder gleich abrufen.'
  } catch (err: any) {
    error.value = err?.message || 'Wohnort konnte nicht gespeichert werden'
  } finally {
    saving.value = false
  }
}

async function saveManual() {
  if (manual.value.lat === null || manual.value.lon === null) return
  saving.value = true
  error.value = ''
  try {
    home.value = (await setMeterHomeLocation({
      label: manual.value.label.trim() || `${fmtCoord(manual.value.lat)}, ${fmtCoord(manual.value.lon)}`,
      lat: manual.value.lat,
      lon: manual.value.lon,
      source: 'manual',
    })).home
    manualMode.value = false
    info.value = 'Wohnort gespeichert.'
  } catch (err: any) {
    error.value = err?.message || 'Wohnort konnte nicht gespeichert werden'
  } finally {
    saving.value = false
  }
}

async function remove() {
  saving.value = true
  error.value = ''
  try {
    await deleteMeterHomeLocation()
    home.value = null
    info.value = ''
  } catch (err: any) {
    error.value = err?.message || 'Wohnort konnte nicht entfernt werden'
  } finally {
    saving.value = false
  }
}

async function fetchNow() {
  fetching.value = true
  error.value = ''
  info.value = ''
  try {
    const res = await fetchDegreeDays()
    if (res.from === null) {
      info.value = 'Nichts abzurufen: Es gibt noch keine Ablesungen eines Heizungszählers.'
    } else if (res.monthsMissing === 0) {
      info.value = `Alle Monate von ${res.from} bis ${res.to} sind bereits vorhanden.`
    } else {
      info.value = `${res.monthsWritten} von ${res.monthsMissing} fehlenden Monaten (${res.from} bis ${res.to}) abgerufen` +
        (res.monthsIncomplete > 0 ? `, ${res.monthsIncomplete} noch unvollständig im Archiv.` : '.')
    }
    if (res.monthsWritten > 0) emit('degree-days-changed')
  } catch (err: any) {
    error.value = err?.message || 'Abruf fehlgeschlagen'
  } finally {
    fetching.value = false
  }
}
</script>

<template>
  <div class="home-card">
    <div class="home-head">
      <h3><i class="pi pi-map-marker" /> Wohnort für Gradtagzahlen</h3>
      <p>
        Gradtagzahlen werden für den Wohnort aus dem Open-Meteo-Archiv geholt (Tagesmittel der
        Temperatur, monatlich summiert nach VDI 2067). Gespeichert wird nur eine auf etwa
        fünf Kilometer gerundete Koordinate.
      </p>
    </div>

    <Message v-if="error" severity="error" closable @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="info" closable @close="info = ''">{{ info }}</Message>

    <div v-if="loading" class="info"><i class="pi pi-spin pi-spinner" /> Lädt…</div>

    <template v-else>
      <div v-if="home" class="home-current">
        <span class="home-label"><strong>{{ home.label }}</strong> ({{ fmtCoord(home.lat) }}, {{ fmtCoord(home.lon) }})</span>
        <div class="home-actions">
          <Button
            v-if="canFetch"
            label="Gradtagzahlen abrufen"
            icon="pi pi-cloud-download"
            size="small"
            :loading="fetching"
            @click="fetchNow"
          />
          <Button
            v-if="canManage"
            icon="pi pi-times"
            label="Entfernen"
            size="small"
            severity="secondary"
            text
            :loading="saving"
            @click="remove"
          />
        </div>
      </div>
      <div v-else class="info">Noch kein Wohnort hinterlegt.</div>

      <template v-if="canManage">
        <div class="search-row">
          <InputText
            v-model="query"
            :placeholder="home ? 'Anderen Ort suchen (Stadt oder Gemeinde)' : 'Ort suchen (Stadt oder Gemeinde)'"
            class="search-input"
            @keyup.enter="search"
          />
          <Button icon="pi pi-search" label="Suchen" size="small" :loading="searching" @click="search" />
          <Button
            :label="manualMode ? 'Ortssuche' : 'Koordinaten eingeben'"
            size="small"
            severity="secondary"
            text
            @click="manualMode = !manualMode"
          />
        </div>

        <ul v-if="candidates.length > 0" class="candidates">
          <li v-for="place in candidates" :key="`${place.lat}-${place.lon}`">
            <button type="button" class="candidate" :disabled="saving" @click="choose(place)">
              <i class="pi pi-map-marker" />
              <span>{{ candidateLabel(place) }}</span>
              <span class="muted">{{ fmtCoord(place.lat) }}, {{ fmtCoord(place.lon) }}</span>
            </button>
          </li>
        </ul>
        <div v-else-if="searched && !searching" class="info">Kein Ort gefunden.</div>

        <div v-if="manualMode" class="manual-grid">
          <label>Bezeichnung
            <InputText v-model="manual.label" placeholder="z. B. Musterstadt" />
          </label>
          <label>Breitengrad
            <InputNumber v-model="manual.lat" :min="-90" :max="90" :min-fraction-digits="2" :max-fraction-digits="4" :pt="decimalInputPt" />
          </label>
          <label>Längengrad
            <InputNumber v-model="manual.lon" :min="-180" :max="180" :min-fraction-digits="2" :max-fraction-digits="4" :pt="decimalInputPt" />
          </label>
          <Button
            label="Speichern"
            icon="pi pi-check"
            size="small"
            :disabled="manual.lat === null || manual.lon === null"
            :loading="saving"
            @click="saveManual"
          />
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.home-card {
  margin-top: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 10px;
  background: var(--p-content-hover-background);
}
.home-head h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--p-text-color);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.home-head p {
  margin: 0.25rem 0 0.6rem;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
  max-width: 80ch;
}
.home-current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}
.home-label {
  font-size: 0.9rem;
  color: var(--p-text-color);
}
.home-actions {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}
.search-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.4rem;
}
.search-input {
  flex: 1;
  min-width: 12rem;
}
.candidates {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.candidate {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.candidate:hover:not(:disabled) {
  border-color: var(--p-primary-color);
}
.candidate .muted {
  margin-left: auto;
  font-size: 0.78rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}
.manual-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.5rem;
  align-items: end;
  margin-top: 0.6rem;
}
.manual-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.info {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
</style>
