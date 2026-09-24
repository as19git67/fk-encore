<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import DatePicker from 'primevue/datepicker'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import SelectButton from 'primevue/selectbutton'
import Slider from 'primevue/slider'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import Tag from 'primevue/tag'
import PageLayout from '../../components/layout/PageLayout.vue'
import PageSkeleton from '../../components/layout/PageSkeleton.vue'
import ErrorBanner from '../../components/layout/ErrorBanner.vue'
import EmptyState from '../../components/layout/EmptyState.vue'
import ForecastItemDialog from '../../components/finance/forecast/ForecastItemDialog.vue'
import ForecastTimeline from '../../components/finance/forecast/ForecastTimeline.vue'
import ForecastCharts from '../../components/finance/forecast/ForecastCharts.vue'
import ForecastMatrix from '../../components/finance/forecast/ForecastMatrix.vue'
import {
  ITEM_TYPE_LABELS,
  MILESTONE_KIND_LABELS,
  POT_LABELS,
  currentAge,
  describeWhen,
  effectiveMilestone,
  formatEur,
  formatPct,
  deflate,
  summarizeItem,
} from '../../components/finance/forecast/forecastModel'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'
import { ApiError } from '../../api/client'
import {
  createForecastItem,
  createForecastMilestone,
  createForecastPerson,
  createForecastScenario,
  deleteForecastItem,
  deleteForecastMilestone,
  deleteForecastPerson,
  deleteForecastScenario,
  getForecast,
  simulateForecast,
  updateForecastItem,
  updateForecastMilestone,
  updateForecastPerson,
  updateForecastScenario,
  type ForecastBundle,
  type ForecastItem,
  type ForecastItemInput,
  type ForecastItemType,
  type ForecastMilestone,
  type ForecastMilestoneKind,
  type ForecastPerson,
  type ForecastScenarioConfig,
  type ForecastSimulateResponse,
} from '../../api/finance'

/**
 * Finanzen › Prognose (issue #1337): from what age do I — or we — no
 * longer need to work? The household (persons, milestones, items) is
 * saved as it is entered; the scenario in the panel is a working copy
 * that is simulated on every change and saved only on request.
 */

const confirm = useConfirm()

// ---- data ------------------------------------------------------------------

const bundle = ref<ForecastBundle | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

const persons = computed(() => bundle.value?.persons ?? [])
const milestones = computed(() => bundle.value?.milestones ?? [])
const items = computed(() => bundle.value?.items ?? [])
const scenarios = computed(() => bundle.value?.scenarios ?? [])

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

async function load() {
  loading.value = true
  error.value = null
  try {
    bundle.value = await getForecast()
    if (!config.value) config.value = cloneConfig(bundle.value.defaultScenario)
    if (earliestFor.value == null) earliestFor.value = persons.value[0]?.id ?? null
    const [first, second] = persons.value
    if (first && second && matrixA.value == null) {
      matrixA.value = first.id
      matrixB.value = second.id
    }
  } catch (err) {
    error.value = message(err)
  } finally {
    loading.value = false
  }
}

// ---- scenario (working copy) ------------------------------------------------

const config = ref<ForecastScenarioConfig | null>(null)
const selectedScenarioId = ref<number | null>(null)
const savedSnapshot = ref<string>('')

function cloneConfig(c: ForecastScenarioConfig): ForecastScenarioConfig {
  return JSON.parse(JSON.stringify(c)) as ForecastScenarioConfig
}

const dirty = computed(() => (config.value ? JSON.stringify(config.value) !== savedSnapshot.value : false))

function selectScenario(id: number | null) {
  selectedScenarioId.value = id
  const s = scenarios.value.find((x) => x.id === id)
  const base = s ? { ...bundle.value!.defaultScenario, ...s.config } : bundle.value!.defaultScenario
  config.value = cloneConfig(base)
  savedSnapshot.value = JSON.stringify(config.value)
}

/** PrimeVue's Select shows nothing for `null`, so the defaults get a sentinel id. */
const DEFAULTS_ID = 0
const scenarioOptions = computed(() => [
  { value: DEFAULTS_ID, label: 'Standardannahmen' },
  ...scenarios.value.map((s) => ({ value: s.id, label: s.name })),
])
const scenarioSelectValue = computed(() => selectedScenarioId.value ?? DEFAULTS_ID)
function onScenarioSelect(v: number) {
  selectScenario(v === DEFAULTS_ID ? null : v)
}

const scenarioDialog = ref(false)
const scenarioName = ref('')
const scenarioSaving = ref(false)
const scenarioError = ref<string | null>(null)

async function saveScenario(asNew: boolean) {
  if (!config.value) return
  scenarioSaving.value = true
  scenarioError.value = null
  try {
    if (asNew || selectedScenarioId.value == null) {
      const s = await createForecastScenario({ name: scenarioName.value.trim() || 'Szenario', config: config.value })
      await load()
      selectedScenarioId.value = s.id
    } else {
      await updateForecastScenario(selectedScenarioId.value, { config: config.value })
      await load()
    }
    savedSnapshot.value = JSON.stringify(config.value)
    scenarioDialog.value = false
  } catch (err) {
    scenarioError.value = message(err)
  } finally {
    scenarioSaving.value = false
  }
}

function removeScenario() {
  const id = selectedScenarioId.value
  const s = scenarios.value.find((x) => x.id === id)
  if (id == null || !s) return
  confirm.require({
    header: 'Szenario löschen',
    message: `Szenario „${s.name}“ löschen? Die Einträge des Haushalts bleiben erhalten.`,
    acceptLabel: 'Löschen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteForecastScenario(id)
        compareIds.value = compareIds.value.filter((x) => x !== id)
        await load()
        selectScenario(null)
      } catch (err) {
        error.value = message(err)
      }
    },
  })
}

// ---- simulation ----------------------------------------------------------------

const sim = ref<ForecastSimulateResponse | null>(null)
const simulating = ref(false)
const simError = ref<string | null>(null)
const earliestFor = ref<number | null>(null)
const compareIds = ref<number[]>([])
const matrixA = ref<number | null>(null)
const matrixB = ref<number | null>(null)
const matrixFrom = ref(58)
const matrixTo = ref(67)
const showMatrix = ref(false)
const real = ref(true)
const selectedYear = ref<number | null>(null)

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = 0

function scheduleSimulation() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(runSimulation, 250)
}

async function runSimulation() {
  if (!config.value || persons.value.length === 0) {
    sim.value = null
    return
  }
  const token = ++inFlight
  simulating.value = true
  simError.value = null
  try {
    const res = await simulateForecast({
      scenario: config.value,
      earliestFor: earliestFor.value ?? undefined,
      compareScenarioIds: compareIds.value,
      matrix:
        showMatrix.value && matrixA.value != null && matrixB.value != null && matrixA.value !== matrixB.value
          ? { personA: matrixA.value, personB: matrixB.value, fromAge: matrixFrom.value, toAge: matrixTo.value }
          : undefined,
    })
    if (token !== inFlight) return
    sim.value = res
    if (selectedYear.value != null && !res.result.years.some((y) => y.year === selectedYear.value)) selectedYear.value = null
  } catch (err) {
    if (token === inFlight) simError.value = message(err)
  } finally {
    if (token === inFlight) simulating.value = false
  }
}

watch([config, earliestFor, compareIds, matrixA, matrixB, matrixFrom, matrixTo, showMatrix], scheduleSimulation, { deep: true })
watch(bundle, scheduleSimulation)

onMounted(load)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const result = computed(() => sim.value?.result ?? null)
const inflation = computed(() => config.value?.inflationRate ?? 0)

function shown(v: number, year: number): number {
  if (!result.value) return v
  return real.value ? deflate(v, year, result.value.startYear, inflation.value) : v
}

const earliestPerson = computed(() => persons.value.find((p) => p.id === sim.value?.earliest?.personId) ?? null)

const verdict = computed(() => {
  const r = result.value
  if (!r) return null
  if (r.ok) return { severity: 'success' as const, text: `Das Geld reicht bis ${r.endYear}. Restvermögen: ${formatEur(shown(r.finalWealth, r.endYear))}.` }
  return { severity: 'warn' as const, text: `Das verfügbare Vermögen fällt ${r.failYear} unter die Grenze von ${formatEur(config.value?.minLiquidWealth ?? 0)}.` }
})

const bridgeRows = computed(() =>
  (result.value?.bridges ?? []).map((b) => ({
    ...b,
    who: b.personId == null ? 'Haushalt' : (persons.value.find((p) => p.id === b.personId)?.label ?? '?'),
  })),
)

// ---- leave-work sliders ------------------------------------------------------------

function leaveMilestone(p: ForecastPerson): ForecastMilestone | undefined {
  return milestones.value.find((m) => m.personId === p.id && m.kind === 'leave_work')
}

function leaveAge(p: ForecastPerson): number | null {
  const m = leaveMilestone(p)
  if (!m || !config.value) return null
  const eff = effectiveMilestone(m, config.value)
  if (eff.age != null) return eff.age
  if (eff.date) return Number(eff.date.slice(0, 4)) - Number(p.birthDate.slice(0, 4))
  return null
}

function setLeaveAge(p: ForecastPerson, age: number | number[]) {
  const m = leaveMilestone(p)
  if (!m || !config.value || Array.isArray(age)) return
  config.value.milestoneOverrides = { ...config.value.milestoneOverrides, [String(m.id)]: { age, date: null } }
}

function moveMilestone(payload: { milestoneId: number; age: number }) {
  if (!config.value) return
  config.value.milestoneOverrides = { ...config.value.milestoneOverrides, [String(payload.milestoneId)]: { age: payload.age, date: null } }
}

const overriddenIds = computed(() => {
  const set = new Set<number>()
  if (!config.value) return set
  for (const m of milestones.value) {
    const o = config.value.milestoneOverrides[String(m.id)]
    if (!o) continue
    if ((o.age != null && o.age !== m.age) || (o.date && o.date !== m.date)) set.add(m.id)
  }
  return set
})

function resetOverrides() {
  if (!config.value) return
  config.value.milestoneOverrides = {}
}

const matrixPersonA = computed(() => persons.value.find((p) => p.id === matrixA.value) ?? null)
const matrixPersonB = computed(() => persons.value.find((p) => p.id === matrixB.value) ?? null)

function pickMatrix(payload: { ageA: number; ageB: number }) {
  const a = persons.value.find((p) => p.id === matrixA.value)
  const b = persons.value.find((p) => p.id === matrixB.value)
  if (a) setLeaveAge(a, payload.ageA)
  if (b) setLeaveAge(b, payload.ageB)
}

// ---- persons -------------------------------------------------------------------------

const personDialog = ref(false)
const personEdit = ref<ForecastPerson | null>(null)
const personLabel = ref('')
const personBirth = ref<Date | null>(null)
const personSaving = ref(false)
const personError = ref<string | null>(null)

function openPerson(p: ForecastPerson | null) {
  personEdit.value = p
  personLabel.value = p?.label ?? ''
  personBirth.value = p ? parseLocalDate(p.birthDate) : null
  personError.value = null
  personDialog.value = true
}

async function savePerson() {
  if (!personLabel.value.trim() || !personBirth.value) return
  personSaving.value = true
  personError.value = null
  try {
    const body = { label: personLabel.value.trim(), birthDate: toLocalIsoDate(personBirth.value) }
    if (personEdit.value) await updateForecastPerson(personEdit.value.id, body)
    else await createForecastPerson(body)
    personDialog.value = false
    await load()
  } catch (err) {
    personError.value = message(err)
  } finally {
    personSaving.value = false
  }
}

function removePerson(p: ForecastPerson) {
  confirm.require({
    header: 'Person entfernen',
    message: `„${p.label}“ mit allen Zeitpunkten und persönlichen Einträgen (Gehalt, Renten, Versicherungen) entfernen?`,
    acceptLabel: 'Entfernen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteForecastPerson(p.id)
        if (earliestFor.value === p.id) earliestFor.value = null
        if (matrixA.value === p.id) matrixA.value = null
        if (matrixB.value === p.id) matrixB.value = null
        await load()
      } catch (err) {
        error.value = message(err)
      }
    },
  })
}

// ---- milestones ------------------------------------------------------------------------

const msDialog = ref(false)
const msEdit = ref<ForecastMilestone | null>(null)
const msPerson = ref<number | null>(null)
const msKind = ref<ForecastMilestoneKind>('custom')
const msLabel = ref('')
const msMode = ref<'age' | 'date'>('age')
const msAge = ref<number | null>(65)
const msDate = ref<Date | null>(null)
const msSaving = ref(false)
const msError = ref<string | null>(null)

const kindOptions = (Object.keys(MILESTONE_KIND_LABELS) as ForecastMilestoneKind[]).map((k) => ({ value: k, label: MILESTONE_KIND_LABELS[k] }))

function openMilestone(m: ForecastMilestone | null, personId?: number) {
  msEdit.value = m
  msPerson.value = m?.personId ?? personId ?? persons.value[0]?.id ?? null
  msKind.value = m?.kind ?? 'custom'
  msLabel.value = m?.label ?? ''
  msMode.value = m?.date ? 'date' : 'age'
  msAge.value = m?.age ?? 65
  msDate.value = m?.date ? parseLocalDate(m.date) : null
  msError.value = null
  msDialog.value = true
}

function openMilestoneById(id: number) {
  const m = milestones.value.find((x) => x.id === id)
  if (m) openMilestone(m)
}

async function saveMilestone() {
  if (msPerson.value == null) return
  msSaving.value = true
  msError.value = null
  try {
    const when = msMode.value === 'age' ? { age: msAge.value, date: null } : { date: msDate.value ? toLocalIsoDate(msDate.value) : null, age: null }
    const label = msLabel.value.trim() || MILESTONE_KIND_LABELS[msKind.value]
    if (msEdit.value) await updateForecastMilestone(msEdit.value.id, { kind: msKind.value, label, ...when })
    else await createForecastMilestone({ personId: msPerson.value, kind: msKind.value, label, ...when })
    msDialog.value = false
    await load()
  } catch (err) {
    msError.value = message(err)
  } finally {
    msSaving.value = false
  }
}

function removeMilestone() {
  const m = msEdit.value
  if (!m) return
  confirm.require({
    header: 'Zeitpunkt löschen',
    message: `„${m.label}“ löschen? Einträge, die daran hängen, verlieren ihren Bezug.`,
    acceptLabel: 'Löschen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteForecastMilestone(m.id)
        msDialog.value = false
        await load()
      } catch (err) {
        msError.value = message(err)
      }
    },
  })
}

// ---- items ---------------------------------------------------------------------------------

const itemDialog = ref(false)
const itemEdit = ref<ForecastItem | null>(null)
const itemPreset = ref<ForecastItemType | null>(null)
const itemSaving = ref(false)
const itemError = ref<string | null>(null)

function openItem(it: ForecastItem | null, preset: ForecastItemType | null = null) {
  itemEdit.value = it
  itemPreset.value = preset
  itemError.value = null
  itemDialog.value = true
}

async function saveItem(body: ForecastItemInput, id: number | null) {
  itemSaving.value = true
  itemError.value = null
  try {
    if (id != null) await updateForecastItem(id, body)
    else await createForecastItem(body)
    itemDialog.value = false
    await load()
  } catch (err) {
    itemError.value = message(err)
  } finally {
    itemSaving.value = false
  }
}

function removeItem(id: number) {
  const it = items.value.find((x) => x.id === id)
  if (!it) return
  confirm.require({
    header: 'Eintrag löschen',
    message: `„${it.label}“ (${ITEM_TYPE_LABELS[it.type]}) löschen?`,
    acceptLabel: 'Löschen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteForecastItem(id)
        itemDialog.value = false
        await load()
      } catch (err) {
        itemError.value = message(err)
      }
    },
  })
}

/** Items grouped: each person, then the household. */
const itemGroups = computed(() => {
  const groups: Array<{ key: string; title: string; personId: number | null; person: ForecastPerson | null; items: ForecastItem[] }> =
    persons.value.map((p) => ({
      key: `p${p.id}`,
      title: p.label,
      personId: p.id,
      person: p,
      items: items.value.filter((it) => it.personId === p.id),
    }))
  groups.push({ key: 'hh', title: 'Haushalt', personId: null, person: null, items: items.value.filter((it) => it.personId == null) })
  return groups
})

// ---- year detail ----------------------------------------------------------------------------

const yearRow = computed(() => result.value?.years.find((y) => y.year === selectedYear.value) ?? null)
const sourceLabel = (key: string) => result.value?.sources.find((s) => s.key === key)?.label ?? key

const yearDetail = computed(() => {
  const r = result.value
  const y = yearRow.value
  if (!r || !y) return null
  const entries = (rec: Record<string, number>) =>
    Object.entries(rec)
      .filter(([, v]) => Math.abs(v) > 0.5)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ key: k, label: sourceLabel(k), value: shown(v, y.year) }))
  return {
    income: entries(y.income),
    expenses: entries(y.expenses),
    withdrawals: Object.entries(y.withdrawals)
      .filter(([, v]) => v > 0.5)
      .map(([k, v]) => ({ key: k, label: POT_LABELS[k as keyof typeof POT_LABELS] ?? k, value: shown(v, y.year) })),
    pots: r.pots.filter((p) => (y.pots[p] ?? 0) > 0.5).map((p) => ({ key: p, label: POT_LABELS[p], value: shown(y.pots[p] ?? 0, y.year) })),
    totalIncome: shown(y.totalIncome, y.year),
    totalExpenses: shown(y.totalExpenses, y.year),
    returns: shown(y.returns, y.year),
    taxes: shown(y.taxes, y.year),
    wealthEnd: shown(y.wealthEnd, y.year),
    liquidEnd: shown(y.liquidEnd, y.year),
  }
})

// ---- assumptions helpers -------------------------------------------------------------------------

const pctModel = (get: () => number, set: (v: number) => void) =>
  computed({
    get: () => Math.round(get() * 10000) / 100,
    set: (v: number | null) => set((v ?? 0) / 100),
  })

const inflationPct = pctModel(() => config.value?.inflationRate ?? 0, (v) => config.value && (config.value.inflationRate = v))
const returnPct = pctModel(() => config.value?.defaultReturnRate ?? 0, (v) => config.value && (config.value.defaultReturnRate = v))
const taxPct = pctModel(() => config.value?.capitalGainsTaxRate ?? 0, (v) => config.value && (config.value.capitalGainsTaxRate = v))
const gainSharePct = pctModel(() => config.value?.depotGainShare ?? 0, (v) => config.value && (config.value.depotGainShare = v))
const hiRatePct = pctModel(() => config.value?.healthInsurance.rate ?? 0, (v) => config.value && (config.value.healthInsurance.rate = v))

const orderOptions = [
  { value: 'cash,depot,other', label: 'Tagesgeld → Depot → Sonstiges' },
  { value: 'depot,cash,other', label: 'Depot → Tagesgeld → Sonstiges' },
  { value: 'cash,other,depot', label: 'Tagesgeld → Sonstiges → Depot' },
]
const orderModel = computed({
  get: () => config.value?.withdrawalOrder.join(',') ?? 'cash,depot,other',
  set: (v: string) => {
    if (config.value) config.value.withdrawalOrder = v.split(',') as ForecastScenarioConfig['withdrawalOrder']
  },
})

const statutoryPensionPersons = computed(() =>
  persons.value.filter((p) => items.value.some((it) => it.type === 'pension' && it.personId === p.id && it.data.kind === 'statutory' && it.data.deductionOffsetCost != null)),
)

function toggleOffset(personId: number, on: boolean) {
  if (!config.value) return
  const set = new Set(config.value.offsetDeductions)
  if (on) set.add(personId)
  else set.delete(personId)
  config.value.offsetDeductions = [...set]
}

function phaseAt(i: number) {
  return config.value?.spendingCurve.phases[i]
}
function setPhase(i: number, key: 'fromAge' | 'factor', v: number | null) {
  const ph = phaseAt(i)
  if (!ph || v == null) return
  ph[key] = key === 'factor' ? v / 100 : v
}

const realOptions = [
  { value: true, label: 'Heutige Kaufkraft' },
  { value: false, label: 'Nominal' },
]

const ready = computed(() => !loading.value)
</script>

<template>
  <PageLayout
    title="Prognose"
    hint="Ab welchem Alter müssen wir nicht mehr arbeiten? Personen, Zeitpunkte und Einträge werden sofort gespeichert; das Szenario ist eine Arbeitskopie."
    width="wide"
    :ready="ready"
  >
    <template #actions>
      <Button label="Person" icon="pi pi-user-plus" size="small" outlined @click="openPerson(null)" />
      <Button label="Eintrag" icon="pi pi-plus" size="small" :disabled="persons.length === 0" @click="openItem(null)" />
    </template>

    <template #notice>
      <ErrorBanner v-if="error" :message="error" @retry="load" />
      <ErrorBanner v-else-if="simError" :message="simError" @retry="runSimulation" />
    </template>

    <PageSkeleton v-if="loading && !bundle" variant="list" :count="4" />

    <EmptyState
      v-else-if="persons.length === 0"
      icon="pi pi-chart-line"
      title="Noch keine Person"
      message="Die Prognose beginnt mit einer Person und ihrem Geburtsdatum. Danach kommen Gehalt, Renten, Versicherungen und Ausgaben."
    >
      <template #action>
        <Button label="Erste Person anlegen" icon="pi pi-user-plus" @click="openPerson(null)" />
      </template>
    </EmptyState>

    <div v-else class="forecast">
      <!-- Result -->
      <section class="card card--result">
        <div class="result">
          <div class="result__main">
            <p class="result__label">Frühestmöglicher Ausstieg</p>
            <p class="result__value" data-testid="earliest">
              <template v-if="sim?.earliest && earliestPerson">
                <template v-if="sim.earliest.age != null">{{ earliestPerson.label }} mit {{ sim.earliest.age }}</template>
                <template v-else>Für {{ earliestPerson.label }} reicht es bei diesen Annahmen mit keinem Alter bis {{ config?.endAge }}.</template>
              </template>
              <template v-else-if="simulating">…</template>
              <template v-else>–</template>
            </p>
            <div class="result__controls">
              <label class="inline-label" for="fc-earliest-for">für</label>
              <Select input-id="fc-earliest-for" v-model="earliestFor" :options="persons" option-label="label" option-value="id" size="small" />
              <span v-if="persons.length > 1" class="muted">(die anderen bleiben bei ihrem Zeitpunkt)</span>
            </div>
          </div>
          <div class="result__side">
            <Message v-if="verdict" :severity="verdict.severity" :closable="false">{{ verdict.text }}</Message>
            <SelectButton v-model="real" :options="realOptions" option-label="label" option-value="value" :allow-empty="false" aria-label="Kaufkraft oder nominal" />
          </div>
        </div>

        <ul v-if="bridgeRows.length" class="bridges">
          <li v-for="b in bridgeRows" :key="`${b.personId}-${b.fromYear}`" class="bridge" :class="{ 'bridge--uncovered': !b.covered }">
            <Tag :severity="b.covered ? 'warn' : 'danger'" :value="b.covered ? 'gedeckt' : 'nicht gedeckt'" />
            <span>
              <strong>{{ b.who }}</strong> — Überbrückung {{ b.fromYear }}–{{ b.toYear }}: benötigt {{ formatEur(shown(b.need, b.fromYear)) }},
              verfügbar {{ formatEur(shown(b.liquidAtStart, b.fromYear)) }}
            </span>
          </li>
        </ul>
      </section>

      <!-- Sliders -->
      <section class="card">
        <h2 class="card__title">Wann aufhören?</h2>
        <div class="sliders">
          <div v-for="p in persons" :key="p.id" class="slider-row">
            <template v-if="leaveMilestone(p)">
              <label :for="`fc-leave-${p.id}`" class="slider-row__label">
                {{ p.label }} hört auf mit <strong>{{ leaveAge(p) }}</strong>
                <span class="muted">({{ (leaveAge(p) ?? 0) + Number(p.birthDate.slice(0, 4)) }})</span>
              </label>
              <Slider
                :id="`fc-leave-${p.id}`"
                :model-value="leaveAge(p) ?? 65"
                :min="Math.max(40, currentAge(p))"
                :max="75"
                :step="1"
                class="slider-row__slider"
                :aria-label="`Ausstiegsalter von ${p.label}`"
                @update:model-value="setLeaveAge(p, $event)"
              />
            </template>
            <p v-else class="muted">{{ p.label }} hat keinen Zeitpunkt „Ausstieg aus dem Beruf“. <Button label="Anlegen" link size="small" @click="openMilestone(null, p.id)" /></p>
          </div>
        </div>
        <div class="sliders__footer">
          <span v-if="overriddenIds.size" class="muted">{{ overriddenIds.size }} Zeitpunkt(e) im Szenario verschoben.</span>
          <Button v-if="overriddenIds.size" label="Zurücksetzen" link size="small" @click="resetOverrides" />
        </div>
      </section>

      <!-- Charts -->
      <ForecastCharts
        v-if="result && config"
        :result="result"
        :persons="persons"
        :comparisons="sim?.comparisons ?? []"
        :real="real"
        :inflation-rate="inflation"
        :min-liquid-wealth="config.minLiquidWealth"
        :selected-year="selectedYear"
        @select-year="selectedYear = $event"
      />
      <PageSkeleton v-else-if="simulating" variant="list" :count="2" />

      <!-- Timeline -->
      <section v-if="result" class="card">
        <h2 class="card__title">Zeitleiste</h2>
        <p class="card__hint">Ziehen verschiebt einen Zeitpunkt im Szenario, ein Klick bearbeitet ihn. Gefüllte Punkte weichen vom gespeicherten Wert ab.</p>
        <ForecastTimeline
          :persons="persons"
          :milestones="milestones"
          :resolved="result.milestones"
          :start-year="result.startYear"
          :end-year="result.endYear"
          :overridden-ids="overriddenIds"
          @move="moveMilestone"
          @edit="openMilestoneById"
          @add="openMilestone(null, $event)"
        />
      </section>

      <!-- Year detail -->
      <section v-if="yearDetail && yearRow" class="card">
        <div class="card__head">
          <h2 class="card__title">{{ yearRow.year }} im Detail</h2>
          <Button icon="pi pi-times" text rounded size="small" aria-label="Jahresdetail schließen" @click="selectedYear = null" />
        </div>
        <div class="detail">
          <div class="detail__col">
            <h3>Einnahmen <span class="muted">{{ formatEur(yearDetail.totalIncome) }}</span></h3>
            <ul>
              <li v-for="e in yearDetail.income" :key="e.key"><span>{{ e.label }}</span><span>{{ formatEur(e.value) }}</span></li>
            </ul>
          </div>
          <div class="detail__col">
            <h3>Ausgaben <span class="muted">{{ formatEur(yearDetail.totalExpenses) }}</span></h3>
            <ul>
              <li v-for="e in yearDetail.expenses" :key="e.key"><span>{{ e.label }}</span><span>{{ formatEur(e.value) }}</span></li>
            </ul>
          </div>
          <div class="detail__col">
            <h3>Entnahmen und Töpfe</h3>
            <ul>
              <li v-for="e in yearDetail.withdrawals" :key="'w' + e.key"><span>Entnahme {{ e.label }}</span><span>{{ formatEur(e.value) }}</span></li>
              <li><span>Erträge nach Steuer</span><span>{{ formatEur(yearDetail.returns) }}</span></li>
              <li><span>Steuern</span><span>{{ formatEur(yearDetail.taxes) }}</span></li>
              <li v-for="e in yearDetail.pots" :key="'p' + e.key"><span>{{ e.label }} am Jahresende</span><span>{{ formatEur(e.value) }}</span></li>
              <li class="detail__total"><span>Vermögen am Jahresende</span><span>{{ formatEur(yearDetail.wealthEnd) }}</span></li>
              <li><span>davon verfügbar</span><span>{{ formatEur(yearDetail.liquidEnd) }}</span></li>
            </ul>
          </div>
        </div>
      </section>

      <!-- Matrix -->
      <section v-if="persons.length >= 2" class="card">
        <div class="card__head">
          <h2 class="card__title">Zwei Personen: Wer hört wann auf?</h2>
          <Checkbox v-model="showMatrix" binary input-id="fc-matrix-on" />
          <label for="fc-matrix-on">berechnen</label>
        </div>
        <div v-if="showMatrix" class="matrix-controls">
          <Select v-model="matrixA" :options="persons" option-label="label" option-value="id" size="small" aria-label="Person A" />
          <span>×</span>
          <Select v-model="matrixB" :options="persons" option-label="label" option-value="id" size="small" aria-label="Person B" />
          <span>Alter</span>
          <InputNumber v-model="matrixFrom" :min="40" :max="80" size="small" aria-label="von Alter" />
          <span>bis</span>
          <InputNumber v-model="matrixTo" :min="40" :max="80" size="small" aria-label="bis Alter" />
        </div>
        <p v-if="showMatrix && matrixA === matrixB" class="muted">Bitte zwei verschiedene Personen wählen.</p>
        <ForecastMatrix
          v-if="showMatrix && sim?.matrix && result && matrixPersonA && matrixPersonB && matrixPersonA !== matrixPersonB"
          :cells="sim.matrix"
          :person-a="matrixPersonA"
          :person-b="matrixPersonB"
          :real="real"
          :inflation-rate="inflation"
          :start-year="result.startYear"
          :end-year="result.endYear"
          @pick="pickMatrix"
        />
      </section>

      <!-- Household -->
      <section class="card">
        <h2 class="card__title">Haushalt</h2>
        <div v-for="g in itemGroups" :key="g.key" class="group">
          <div class="group__head">
            <h3 class="group__title">
              {{ g.title }}
              <span v-if="g.person" class="muted">· {{ currentAge(g.person) }} Jahre</span>
            </h3>
            <div class="group__actions">
              <template v-if="g.person">
                <Button icon="pi pi-pencil" text rounded size="small" aria-label="Person bearbeiten" @click="openPerson(g.person)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Person entfernen" @click="removePerson(g.person)" />
              </template>
              <Button label="Eintrag" icon="pi pi-plus" text size="small" @click="openItem(null, g.personId == null ? 'living_expense' : 'salary')" />
            </div>
          </div>
          <ul v-if="g.personId != null" class="milestone-list">
            <li v-for="m in milestones.filter((x) => x.personId === g.personId)" :key="m.id">
              <button type="button" class="chip" :class="{ 'chip--overridden': overriddenIds.has(m.id) }" @click="openMilestone(m)">
                {{ m.label }} {{ describeWhen(config ? effectiveMilestone(m, config) : m) }}
              </button>
            </li>
            <li>
              <button type="button" class="chip chip--add" @click="openMilestone(null, g.personId ?? undefined)"><i class="pi pi-plus" aria-hidden="true" /> Zeitpunkt</button>
            </li>
          </ul>
          <ul class="item-list">
            <li v-for="it in g.items" :key="it.id">
              <button type="button" class="item" @click="openItem(it)">
                <span class="item__type">{{ ITEM_TYPE_LABELS[it.type] }}</span>
                <span class="item__label">{{ it.label }}</span>
                <span class="item__summary">{{ summarizeItem(it.type, it.data, it.linkedAccountBalance) }}</span>
              </button>
            </li>
            <li v-if="g.items.length === 0" class="muted item-list__empty">Noch keine Einträge.</li>
          </ul>
        </div>
      </section>

      <!-- Scenario -->
      <section v-if="config" class="card">
        <div class="card__head">
          <h2 class="card__title">Annahmen und Szenario</h2>
          <Select :model-value="scenarioSelectValue" :options="scenarioOptions" option-label="label" option-value="value" size="small" aria-label="Szenario" @update:model-value="onScenarioSelect" />
          <Tag v-if="dirty" value="geändert" severity="info" />
        </div>
        <div class="assumptions">
          <div class="field"><label for="fc-infl">Inflation pro Jahr</label><InputNumber input-id="fc-infl" v-model="inflationPct" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" /></div>
          <div class="field"><label for="fc-ret">Rendite pro Jahr (Standard)</label><InputNumber input-id="fc-ret" v-model="returnPct" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" /></div>
          <div class="field"><label for="fc-tax">Kapitalertragsteuer</label><InputNumber input-id="fc-tax" v-model="taxPct" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="3" /></div>
          <div class="field"><label for="fc-gain">Gewinnanteil bei Depotverkauf</label><InputNumber input-id="fc-gain" v-model="gainSharePct" suffix=" %" :min-fraction-digits="0" :max-fraction-digits="0" /></div>
          <div class="field"><label for="fc-end">Rechnen bis Alter (jüngste Person)</label><InputNumber input-id="fc-end" v-model="config.endAge" :min="60" :max="110" suffix=" Jahre" /></div>
          <div class="field"><label for="fc-min">Sicherheitspuffer (verfügbar)</label><InputNumber input-id="fc-min" v-model="config.minLiquidWealth" mode="currency" currency="EUR" locale="de-DE" /></div>
          <div class="field"><label for="fc-order">Reihenfolge der Entnahme</label><Select input-id="fc-order" v-model="orderModel" :options="orderOptions" option-label="label" option-value="value" /></div>
          <div class="field field--inline"><label for="fc-surrender">Versicherungen notfalls vorzeitig kündigen</label><Checkbox input-id="fc-surrender" v-model="config.allowSurrender" binary /></div>
          <div class="field"><label for="fc-hi-rate">Beitragssatz gesetzliche KV (inkl. Pflege)</label><InputNumber input-id="fc-hi-rate" v-model="hiRatePct" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" /></div>
          <div class="field"><label for="fc-hi-min">Mindestbeitrag freiwillig Versicherte</label><InputNumber input-id="fc-hi-min" v-model="config.healthInsurance.minMonthly" mode="currency" currency="EUR" locale="de-DE" /></div>
        </div>

        <h3 class="sub">Ausgaben im Alter</h3>
        <p class="card__hint">Faktor auf die Lebenshaltung ab dem Alter der Bezugsperson; Pflegekosten kommen pro Person dazu.</p>
        <div class="assumptions">
          <div class="field"><label for="fc-ref">Bezugsperson</label><Select input-id="fc-ref" v-model="config.spendingCurve.referencePersonId" :options="persons" option-label="label" option-value="id" placeholder="Erste Person" show-clear /></div>
          <div v-for="(_, i) in config.spendingCurve.phases" :key="i" class="field field--phase">
            <label>Phase {{ i + 1 }}</label>
            <div class="phase">
              <InputNumber :model-value="phaseAt(i)?.fromAge ?? 0" :min="0" :max="120" prefix="ab " suffix=" J." :aria-label="`Phase ${i + 1} ab Alter`" @update:model-value="setPhase(i, 'fromAge', $event)" />
              <InputNumber :model-value="Math.round((phaseAt(i)?.factor ?? 1) * 100)" :min="0" :max="300" suffix=" %" :aria-label="`Phase ${i + 1} Faktor`" @update:model-value="setPhase(i, 'factor', $event)" />
            </div>
          </div>
          <div class="field"><label for="fc-care-age">Pflege ab Alter</label><InputNumber input-id="fc-care-age" v-model="config.spendingCurve.careFromAge" :min="60" :max="110" suffix=" Jahre" /></div>
          <div class="field"><label for="fc-care">Pflegekosten pro Person und Monat</label><InputNumber input-id="fc-care" v-model="config.spendingCurve.careMonthly" mode="currency" currency="EUR" locale="de-DE" /></div>
        </div>

        <template v-if="statutoryPensionPersons.length">
          <h3 class="sub">Abschläge ausgleichen (§ 187a SGB VI)</h3>
          <div v-for="p in statutoryPensionPersons" :key="p.id" class="field field--inline">
            <label :for="`fc-offset-${p.id}`">{{ p.label }}: Ausgleichszahlung heute leisten, volle Rente ab Beginn</label>
            <Checkbox :input-id="`fc-offset-${p.id}`" :model-value="config.offsetDeductions.includes(p.id)" binary @update:model-value="toggleOffset(p.id, $event)" />
          </div>
        </template>

        <div class="scenario-actions">
          <MultiSelect
            v-model="compareIds"
            :options="scenarios"
            option-label="name"
            option-value="id"
            placeholder="Szenarien vergleichen"
            display="chip"
            size="small"
            :disabled="scenarios.length === 0"
            aria-label="Szenarien zum Vergleich"
          />
          <span class="spacer" />
          <Button v-if="selectedScenarioId != null" label="Löschen" icon="pi pi-trash" severity="danger" text size="small" @click="removeScenario" />
          <Button label="Als neues Szenario" icon="pi pi-copy" outlined size="small" @click="scenarioName = ''; scenarioDialog = true" />
          <Button v-if="selectedScenarioId != null" label="Speichern" icon="pi pi-save" size="small" :disabled="!dirty" @click="saveScenario(false)" />
        </div>
        <p class="card__hint">
          Aktuell: Inflation {{ formatPct(config.inflationRate) }}, Rendite {{ formatPct(config.defaultReturnRate) }}, bis {{ config.endAge }}.
          Steuern sind pauschal; Einkommensteuer und Rentenbesteuerung im Detail kommen später.
        </p>
      </section>
    </div>

    <!-- Dialogs -->
    <Dialog class="dialog-sm" v-model:visible="personDialog" modal :header="personEdit ? 'Person bearbeiten' : 'Neue Person'">
      <Message v-if="personError" severity="error" :closable="false">{{ personError }}</Message>
      <div class="field"><label for="fc-person-label">Name</label><InputText id="fc-person-label" v-model="personLabel" autofocus /></div>
      <div class="field">
        <label for="fc-person-birth">Geburtsdatum</label>
        <DatePicker input-id="fc-person-birth" v-model="personBirth" date-format="dd.mm.yy" show-icon />
      </div>
      <p v-if="!personEdit" class="card__hint">Die Person bekommt die Zeitpunkte „Ausstieg aus dem Beruf“ (63) und „Gesetzliche Rente“ (67), die sich danach anpassen lassen.</p>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="personDialog = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="personSaving" :disabled="!personLabel.trim() || !personBirth" @click="savePerson" />
      </template>
    </Dialog>

    <Dialog class="dialog-sm" v-model:visible="msDialog" modal :header="msEdit ? 'Zeitpunkt bearbeiten' : 'Neuer Zeitpunkt'">
      <Message v-if="msError" severity="error" :closable="false">{{ msError }}</Message>
      <div class="field"><label for="fc-ms-person">Person</label><Select input-id="fc-ms-person" v-model="msPerson" :options="persons" option-label="label" option-value="id" :disabled="!!msEdit" /></div>
      <div class="field"><label for="fc-ms-kind">Art</label><Select input-id="fc-ms-kind" v-model="msKind" :options="kindOptions" option-label="label" option-value="value" /></div>
      <div class="field"><label for="fc-ms-label">Bezeichnung</label><InputText id="fc-ms-label" v-model="msLabel" :placeholder="MILESTONE_KIND_LABELS[msKind]" /></div>
      <div class="field">
        <label>Wann</label>
        <SelectButton v-model="msMode" :options="[{ value: 'age', label: 'Alter' }, { value: 'date', label: 'Datum' }]" option-label="label" option-value="value" :allow-empty="false" aria-label="Alter oder Datum" />
      </div>
      <div v-if="msMode === 'age'" class="field"><label for="fc-ms-age">Alter</label><InputNumber input-id="fc-ms-age" v-model="msAge" :min="0" :max="120" suffix=" Jahre" /></div>
      <div v-else class="field"><label for="fc-ms-date">Datum</label><DatePicker input-id="fc-ms-date" v-model="msDate" date-format="dd.mm.yy" show-icon /></div>
      <template #footer>
        <Button v-if="msEdit" label="Löschen" icon="pi pi-trash" severity="danger" text class="footer-leading-btn" @click="removeMilestone" />
        <Button label="Abbrechen" severity="secondary" text @click="msDialog = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="msSaving" :disabled="msPerson == null || (msMode === 'age' ? msAge == null : !msDate)" @click="saveMilestone" />
      </template>
    </Dialog>

    <ForecastItemDialog
      v-model:visible="itemDialog"
      :item="itemEdit"
      :preset-type="itemPreset"
      :persons="persons"
      :milestones="milestones"
      :accounts="bundle?.accounts ?? []"
      :saving="itemSaving"
      :error="itemError"
      @save="saveItem"
      @delete="removeItem"
    />

    <Dialog class="dialog-sm" v-model:visible="scenarioDialog" modal header="Szenario speichern">
      <Message v-if="scenarioError" severity="error" :closable="false">{{ scenarioError }}</Message>
      <div class="field"><label for="fc-scenario-name">Name</label><InputText id="fc-scenario-name" v-model="scenarioName" placeholder="z. B. Beide mit 62" autofocus /></div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="scenarioDialog = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="scenarioSaving" @click="saveScenario(true)" />
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.forecast {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.card {
  background: var(--p-content-background);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  padding: var(--space-3) var(--space-4);
  min-width: 0;
}
.card__title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xl);
}
.card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
}
.card__head .card__title {
  margin: 0;
  flex: 1 1 auto;
}
.card__hint,
.muted {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.card__hint {
  margin: 0 0 var(--space-3);
}
.sub {
  margin: var(--space-4) 0 var(--space-1);
  font-size: var(--text-lg);
}

/* result */
.result {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  align-items: flex-start;
}
.result__main {
  flex: 1 1 280px;
  min-width: 0;
}
.result__side {
  flex: 1 1 280px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
  min-width: 0;
}
.result__label {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: var(--text-xs);
  color: var(--p-text-muted-color);
}
.result__value {
  margin: var(--space-1) 0 var(--space-2);
  font-size: var(--text-3xl);
  font-weight: 700;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.result__controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.inline-label {
  color: var(--p-text-muted-color);
}
.bridges {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.bridge {
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  font-size: var(--text-base);
}

/* sliders */
.sliders {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.slider-row__label {
  display: block;
  margin-bottom: var(--space-2);
}
.slider-row__slider {
  margin: 0 var(--space-2);
}
.sliders__footer {
  margin-top: var(--space-3);
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

/* detail */
.detail {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-4);
}
.detail h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-lg);
}
.detail ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.detail li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 2px 0;
  border-bottom: 1px solid var(--p-content-border-color);
  font-size: var(--text-base);
}
.detail li span:last-child {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.detail__total {
  font-weight: 600;
}

/* matrix controls */
.matrix-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}
.matrix-controls :deep(.p-inputnumber-input) {
  width: 5rem;
}

/* household */
.group {
  padding: var(--space-2) 0;
  border-top: 1px solid var(--p-content-border-color);
}
.group:first-of-type {
  border-top: none;
}
.group__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.group__title {
  margin: 0;
  font-size: var(--text-lg);
  flex: 1 1 auto;
}
.group__actions {
  display: flex;
  gap: var(--space-1);
  align-items: center;
}
.milestone-list,
.item-list {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
}
.item-list {
  flex-direction: column;
  gap: 0;
}
.chip {
  border: 1px solid var(--p-content-border-color);
  background: transparent;
  color: var(--p-text-color);
  border-radius: 999px;
  padding: 2px var(--space-2);
  font-size: var(--text-sm);
  cursor: pointer;
}
.chip:hover {
  background: var(--p-content-hover-background);
}
.chip:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.chip--overridden {
  border-color: var(--p-primary-color);
  color: var(--p-primary-color);
}
.chip--add {
  border-style: dashed;
  color: var(--p-text-muted-color);
}
.item {
  display: grid;
  grid-template-columns: minmax(120px, 160px) 1fr auto;
  gap: var(--space-2);
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  padding: var(--space-1) var(--space-2);
  margin: 0 calc(-1 * var(--space-2));
  width: calc(100% + 2 * var(--space-2));
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  align-items: baseline;
}
.item:hover {
  background: var(--p-content-hover-background);
}
.item:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset-inset);
}
.item__type {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.item__label {
  min-width: 0;
  overflow-wrap: anywhere;
}
.item__summary {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  font-size: var(--text-base);
}
.item-list__empty {
  padding: var(--space-1) 0;
}
@media (max-width: 639px) {
  .item {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .item__summary {
    white-space: normal;
  }
}

/* assumptions */
.assumptions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  column-gap: var(--space-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
  min-width: 0;
}
.field--inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.field label {
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}
.phase {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.scenario-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-3);
}
.spacer {
  flex: 1 1 auto;
}
.footer-leading-btn {
  margin-right: auto;
}
</style>
