<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import Message from 'primevue/message'
import ScrollX from '../../layout/ScrollX.vue'
import { ApiError } from '../../../api/client'
import {
  commitForecastImport,
  evaluateForecastImport,
  previewForecastImport,
  type ForecastImportChoice,
  type ForecastImportPreview,
  type ForecastImportRaw,
  type ForecastItemType,
  type ForecastPerson,
  type ForecastScanSummary,
} from '../../../api/finance'
import { ITEM_TYPE_LABELS, PERSONAL_ITEM_TYPES, formatPct } from './forecastModel'

/**
 * One-time import of a spreadsheet overview into the forecast (#1337).
 *
 * The backend reads the workbook and proposes an item per row; here the
 * user decides per row whether to take it, as what and for whom, and can
 * add a year the sheet lacks. Every change is described again by the
 * backend, so what the table says is what will be created.
 */

const props = defineProps<{
  visible: boolean
  persons: ForecastPerson[]
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'imported', count: number, statements: ForecastScanSummary): void
  (e: 'apply-inflation', rate: number): void
}>()

interface Row {
  row: number
  label: string
  raw: ForecastImportRaw
  type: ForecastItemType | null
  personId: number | null
  include: boolean
  reason: string | null
  summary: string | null
  error: string | null
  evaluating: boolean
}

const preview = ref<ForecastImportPreview | null>(null)
const rows = ref<Row[]>([])
const fileName = ref<string | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.visible,
  (v) => {
    if (!v) return
    preview.value = null
    rows.value = []
    fileName.value = null
    error.value = null
  },
)

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  fileName.value = file.name
  loading.value = true
  error.value = null
  try {
    const p = await previewForecastImport(toBase64(await file.arrayBuffer()))
    preview.value = p
    rows.value = p.rows.map((r) => ({
      row: r.row,
      label: r.label,
      raw: { ...r.raw },
      type: r.suggestion.type,
      personId: r.suggestion.personId,
      include: r.suggestion.include,
      reason: r.suggestion.reason,
      summary: r.summary,
      error: null,
      evaluating: false,
    }))
  } catch (err) {
    preview.value = null
    rows.value = []
    error.value = message(err)
  } finally {
    loading.value = false
  }
}

const typeOptions = (Object.keys(ITEM_TYPE_LABELS) as ForecastItemType[]).map((t) => ({ value: t, label: ITEM_TYPE_LABELS[t] }))

/** PrimeVue's Select shows nothing for `null`, so the household gets a sentinel id. */
const HOUSEHOLD = 0
const personOptions = computed(() => [
  { value: HOUSEHOLD, label: 'Haushalt' },
  ...props.persons.map((p) => ({ value: p.id, label: p.label })),
])

const growth = computed(() => preview.value?.pensionGrowthRate ?? null)

function choice(r: Row): ForecastImportChoice | null {
  if (!r.type) return null
  return { label: r.label, type: r.type, personId: r.personId, raw: r.raw }
}

const timers = new Map<number, ReturnType<typeof setTimeout>>()

/** Asks the backend to describe the row again after an edit. */
function reevaluate(r: Row) {
  const prev = timers.get(r.row)
  if (prev) clearTimeout(prev)
  timers.set(
    r.row,
    setTimeout(async () => {
      const c = choice(r)
      if (!c) {
        r.summary = null
        r.error = 'Bitte eine Art wählen'
        r.include = false
        return
      }
      r.evaluating = true
      try {
        const res = await evaluateForecastImport([c], growth.value)
        const e = res.rows[0]
        r.summary = e?.summary ?? null
        r.error = e?.error ?? null
        // A row that just became complete is taken; one that broke is dropped.
        r.include = !r.error
      } catch (err) {
        r.error = message(err)
        r.include = false
      } finally {
        r.evaluating = false
      }
    }, 250),
  )
}

function setType(r: Row, t: ForecastItemType) {
  r.type = t
  if (PERSONAL_ITEM_TYPES.has(t) && r.personId == null) r.personId = props.persons[0]?.id ?? null
  r.reason = null
  reevaluate(r)
}

function setPerson(r: Row, p: number) {
  r.personId = p === HOUSEHOLD ? null : p
  reevaluate(r)
}

function setYear(r: Row, key: 'payoutYear' | 'contributionUntilYear', v: number | null) {
  r.raw = { ...r.raw, [key]: v }
  reevaluate(r)
}

const selected = computed(() => rows.value.filter((r) => r.include && r.type && !r.error))
const busy = computed(() => rows.value.some((r) => r.evaluating))

function selectAll(on: boolean) {
  for (const r of rows.value) if (r.type && !r.error && r.summary) r.include = on
}

async function commit() {
  const chosen = selected.value.map(choice).filter((c): c is ForecastImportChoice => c !== null)
  if (chosen.length === 0) return
  saving.value = true
  error.value = null
  try {
    const res = await commitForecastImport(chosen, growth.value)
    emit('imported', res.created, res.statements)
    emit('update:visible', false)
  } catch (err) {
    error.value = message(err)
  } finally {
    saving.value = false
  }
}

const fmt = (n: number | null) =>
  n == null ? '' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(n)
</script>

<template>
  <Dialog
    class="dialog-lg"
    :visible="visible"
    modal
    header="Aus Excel importieren"
    @update:visible="emit('update:visible', $event)"
  >
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="pick">
      <input ref="fileInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="pick__input" @change="onFile" />
      <Button
        :label="fileName ? 'Andere Datei wählen' : 'Excel-Datei wählen'"
        icon="pi pi-file-excel"
        :outlined="!!fileName"
        :loading="loading"
        @click="fileInput?.click()"
      />
      <span v-if="fileName" class="muted">{{ fileName }}<template v-if="preview"> · Blatt „{{ preview.sheet }}“, {{ rows.length }} Zeilen</template></span>
    </div>
    <p v-if="!preview" class="hint">
      Erwartet wird eine Übersicht mit den Spalten „Betrag“, „jährliche Einnahmen“, „jährliche Ausgaben“, „einmalige Einnahmen/Ausgaben“,
      „Beitragszahlung bis“ und „Auszahlung im Jahr“ — eine Zeile pro Posten. Blätter pro Vertrag (Versicherungsnummer, Ablauf, Anteilswert)
      werden dazugelesen. Nichts wird gespeichert, bevor du die Vorschau übernimmst.
    </p>

    <template v-if="preview">
      <Message v-for="w in preview.warnings" :key="w" severity="warn" :closable="false">{{ w }}</Message>
      <p v-if="preview.inflationRate != null || preview.pensionGrowthRate != null" class="assumptions">
        In der Datei:
        <template v-if="preview.inflationRate != null">
          Inflation {{ formatPct(preview.inflationRate) }}
          <Button label="im Szenario übernehmen" link size="small" @click="emit('apply-inflation', preview.inflationRate!)" />
        </template>
        <template v-if="preview.pensionGrowthRate != null"> · Rentenanpassung {{ formatPct(preview.pensionGrowthRate) }} (gilt für die importierten Renten)</template>
      </p>

      <ScrollX>
        <table class="rows">
          <thead>
            <tr>
              <th scope="col" class="rows__check">
                <Checkbox
                  :model-value="selected.length > 0 && selected.length === rows.filter((r) => r.type && !r.error && r.summary).length"
                  binary
                  aria-label="Alle übernehmen"
                  @update:model-value="selectAll($event)"
                />
              </th>
              <th scope="col">Zeile</th>
              <th scope="col">Art</th>
              <th scope="col">Person</th>
              <th scope="col">Auszahlung</th>
              <th scope="col">Beitrag bis</th>
              <th scope="col">Wird zu</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.row" :class="{ 'rows__row--off': !r.include }">
              <td class="rows__check">
                <Checkbox v-model="r.include" binary :disabled="!r.type || !!r.error || !r.summary" :aria-label="`${r.label} übernehmen`" />
              </td>
              <td class="rows__label">
                <span class="rows__name">{{ r.label }}</span>
                <span class="rows__raw muted">
                  <template v-if="r.raw.amount">Betrag {{ fmt(r.raw.amount) }} · </template>
                  <template v-if="r.raw.incomeYearly">+{{ fmt(r.raw.incomeYearly) }}/J. · </template>
                  <template v-if="r.raw.expenseYearly">{{ fmt(r.raw.expenseYearly) }}/J. · </template>
                  <template v-if="r.raw.once">einmalig {{ fmt(r.raw.once) }}</template>
                </span>
                <span v-if="r.raw.note" class="rows__note muted">{{ r.raw.note }}</span>
              </td>
              <td>
                <Select
                  :model-value="r.type"
                  :options="typeOptions"
                  option-label="label"
                  option-value="value"
                  placeholder="—"
                  size="small"
                  class="rows__select"
                  :aria-label="`Art für ${r.label}`"
                  @update:model-value="setType(r, $event)"
                />
              </td>
              <td>
                <Select
                  :model-value="r.personId ?? HOUSEHOLD"
                  :options="personOptions"
                  option-label="label"
                  option-value="value"
                  size="small"
                  class="rows__select rows__select--person"
                  :aria-label="`Person für ${r.label}`"
                  @update:model-value="setPerson(r, $event)"
                />
              </td>
              <td>
                <InputNumber
                  :model-value="r.raw.payoutYear"
                  :use-grouping="false"
                  :min="1950"
                  :max="2150"
                  size="small"
                  input-class="rows__year"
                  :aria-label="`Auszahlungsjahr für ${r.label}`"
                  @update:model-value="setYear(r, 'payoutYear', $event)"
                />
              </td>
              <td>
                <InputNumber
                  :model-value="r.raw.contributionUntilYear"
                  :use-grouping="false"
                  :min="1950"
                  :max="2150"
                  size="small"
                  input-class="rows__year"
                  :aria-label="`Beitragszahlung bis für ${r.label}`"
                  @update:model-value="setYear(r, 'contributionUntilYear', $event)"
                />
              </td>
              <td class="rows__result">
                <i v-if="r.evaluating" class="pi pi-spin pi-spinner muted" aria-hidden="true" />
                <span v-else-if="r.error" class="rows__error">{{ r.error }}</span>
                <span v-else>{{ r.summary ?? '—' }}</span>
                <span v-if="r.reason && !r.error" class="rows__reason">{{ r.reason }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </ScrollX>
      <p class="hint">
        Jahre gelten ab Januar; ein Beitrag „bis 2032“ läuft bis Dezember 2032. Übernommene Einträge lassen sich danach einzeln bearbeiten,
        etwa um sie an einen Zeitpunkt wie den Rentenbeginn zu hängen.
      </p>
    </template>

    <template #footer>
      <Button label="Abbrechen" severity="secondary" text :disabled="saving" @click="emit('update:visible', false)" />
      <Button
        :label="selected.length ? `${selected.length} Einträge übernehmen` : 'Übernehmen'"
        icon="pi pi-check"
        :loading="saving"
        :disabled="selected.length === 0 || busy"
        @click="commit"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.pick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.pick__input {
  display: none;
}
.hint,
.muted {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.hint {
  margin: var(--space-2) 0;
}
.assumptions {
  margin: 0 0 var(--space-2);
  font-size: var(--text-base);
}
.rows {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--text-base);
}
.rows th {
  text-align: left;
  font-weight: 600;
  color: var(--p-text-muted-color);
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  white-space: nowrap;
}
.rows td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--p-content-border-color);
  vertical-align: top;
}
.rows__row--off td {
  opacity: 0.6;
}
.rows__check {
  width: 2.5rem;
}
.rows__label {
  min-width: 12rem;
}
.rows__name {
  display: block;
  font-weight: 600;
}
.rows__raw,
.rows__note {
  display: block;
}
.rows__note {
  font-style: italic;
}
.rows__select {
  width: 10.5rem;
}
.rows__select--person {
  width: 7.5rem;
}
.rows :deep(.rows__year) {
  width: 4.5rem;
}
.rows__result {
  min-width: 13rem;
}
.rows__error {
  color: var(--p-red-500);
}
.rows__reason {
  display: block;
  color: var(--p-orange-500);
  font-size: var(--text-sm);
}
</style>
