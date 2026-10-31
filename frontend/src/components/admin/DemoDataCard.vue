<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import ProgressBar from 'primevue/progressbar'
import {
  cancelDemo,
  getDemoStatus,
  getDemoTruth,
  removeDemo,
  startDemo,
  type DemoContentCounts,
  type DemoStatus,
  type DemoTruthField,
  type DemoTruthReport,
} from '../../api/demo'
import { useConfirmAsync } from '../../composables/useConfirmAsync'

/**
 * Demo data for a fresh system (documentation/plans/demodaten.md): load it
 * while nobody has put anything in, watch it load, take it back. The card
 * hides itself for a user the server does not let in (no Admin role).
 */

const status = ref<DemoStatus | null>(null)
const hidden = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
/** Whether the local model words the documents (hours) or the templates do (minutes). */
const useModel = ref(true)
const truth = ref<DemoTruthReport | null>(null)
const truthLoading = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const run = computed(() => status.value?.run ?? null)
const loading = computed(() => run.value?.status === 'running' || run.value?.status === 'cancelling')

const COUNT_LABELS: Record<keyof DemoContentCounts, string> = {
  users: 'Benutzer',
  photos: 'Fotos',
  documents: 'Dokumente',
  transactions: 'Buchungen',
  depot_transactions: 'Depotbuchungen',
  meter_readings: 'Zählerstände',
  trip_plans: 'Reisen',
}

const SUMMARY_LABELS: Record<string, string> = {
  users: 'zweite Benutzerin',
  accounts: 'Konten',
  bookings: 'Buchungen',
  documents: 'Dokumente',
  worded: 'davon von der KI formuliert',
  scans: 'davon als Scan',
  depot: 'Depot',
  depot_papers: 'Depotpapiere',
}

const FIELD_LABELS: Record<DemoTruthField, string> = {
  category: 'Kategorie',
  document_type: 'Dokumentart',
  sender: 'Absender',
  date: 'Datum',
  tax_role: 'Steuerrolle',
}

const STAGE_LABELS: Record<string, string> = {
  household: 'Haushalt',
  bookings: 'Buchungen',
  quotes: 'Kurse',
  documents: 'Dokumente',
  remove: 'Entfernen',
}

/** Why the button is not offered: what the system holds already. */
const heldLine = computed(() => {
  const c = status.value?.counts
  if (!c) return ''
  return (Object.keys(COUNT_LABELS) as Array<keyof DemoContentCounts>)
    .filter((k) => c[k] > 0)
    .map((k) => `${c[k]} ${COUNT_LABELS[k]}`)
    .join(', ')
})

const progress = computed(() => {
  const r = run.value
  if (!r?.stage) return null
  const p = r.progress[r.stage]
  return {
    label: STAGE_LABELS[r.stage] ?? r.stage,
    done: p?.done ?? 0,
    total: p?.total ?? 0,
    percent: p && p.total ? Math.round((p.done / p.total) * 100) : 0,
  }
})

const summaryLine = computed(() => {
  const s = run.value?.summary
  if (!s) return ''
  return Object.entries(s)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${SUMMARY_LABELS[k] ?? k}`)
    .join(', ')
})

const outcomeLine = computed(() => {
  switch (run.value?.status) {
    case 'done': return 'Demodaten sind geladen.'
    case 'cancelled': return 'Abgebrochen — was bis dahin geschrieben war, liegt noch im System.'
    case 'failed': return `Fehlgeschlagen: ${run.value.error ?? 'unbekannter Fehler'}. Was bis dahin geschrieben war, liegt noch im System.`
    case 'removing': return 'Demodaten werden entfernt …'
    default: return ''
  }
})

function schedule() {
  if (timer) clearTimeout(timer)
  timer = loading.value || run.value?.status === 'removing' ? setTimeout(() => void refresh(), 1500) : null
}

function percent(hits: number, compared: number): string {
  return compared ? `${Math.round((hits / compared) * 100)} %` : '–'
}

async function loadTruth() {
  truthLoading.value = true
  try {
    truth.value = await getDemoTruth()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Abgleich nicht abrufbar.'
  } finally {
    truthLoading.value = false
  }
}

async function refresh() {
  try {
    status.value = await getDemoStatus()
    error.value = null
    if (status.value.run?.status === 'done' && (status.value.run.summary?.documents ?? 0) > 0 && !truth.value) void loadTruth()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'permission_denied') hidden.value = true
    else error.value = e instanceof Error ? e.message : 'Status nicht abrufbar.'
  }
  schedule()
}

async function act(fn: () => Promise<DemoStatus>) {
  busy.value = true
  try {
    status.value = await fn()
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Aktion fehlgeschlagen.'
  } finally {
    busy.value = false
    schedule()
  }
}

const askConfirm = useConfirmAsync()

async function remove() {
  const what = summaryLine.value ? ` (${summaryLine.value})` : ''
  if (!(await askConfirm({
    header: 'Demodaten entfernen',
    message: `Alles entfernen, was die Demo angelegt hat${what}? Die Demo-Benutzerin, die Konten mit allen Buchungen und die Demo-Dokumente werden gelöscht. Was du selbst angelegt hast, bleibt.`,
    acceptLabel: 'Entfernen',
    danger: true,
  }))) return
  truth.value = null
  await act(removeDemo)
}

onMounted(() => void refresh())
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <section v-if="!hidden" class="demo-section">
    <h2 class="demo-section__title">Demodaten</h2>
    <div class="demo-card">
    <div class="demo-card__head">
      <i class="pi pi-box" />
      <span class="demo-card__label">Demodaten</span>
    </div>
    <p class="demo-card__desc">
      Ein Beispielhaushalt zum Ausprobieren: eine zweite Benutzerin, ein gemeinsames Konto, drei Jahre
      Buchungen, ein Depot mit Indexfonds zu echten Kursen und 500 Dokumente, die durch die normale
      Erkennung laufen. Nur in einem System, in das
      noch niemand etwas eingetragen hat.
    </p>

    <p v-if="!status && !error" class="demo-card__line">Wird geladen …</p>

    <template v-else-if="status && !run">
      <div v-if="status.untouched" class="demo-card__option">
        <Checkbox v-model="useModel" input-id="demo-use-model" binary />
        <label for="demo-use-model">Texte der Dokumente von der KI schreiben lassen (dauert einige Stunden)</label>
      </div>
      <Button
        v-if="status.untouched"
        label="Demodaten laden"
        icon="pi pi-download"
        size="small"
        outlined
        :loading="busy"
        @click="act(() => startDemo(useModel ? 'llm' : 'template'))"
      />
      <p v-else class="demo-card__line">
        Nicht verfügbar: Das System enthält schon Daten ({{ heldLine }}).
      </p>
    </template>

    <template v-else-if="run && loading">
      <p class="demo-card__line" aria-live="polite">
        {{ run.status === 'cancelling' ? 'Wird abgebrochen …' : `Wird geladen: ${progress?.label ?? '…'}` }}
        <template v-if="progress && progress.total">({{ progress.done }} von {{ progress.total }})</template>
      </p>
      <ProgressBar :value="progress?.percent ?? 0" :show-value="false" class="demo-card__bar" />
      <Button
        label="Abbrechen"
        icon="pi pi-times"
        size="small"
        severity="secondary"
        outlined
        :disabled="run.status === 'cancelling'"
        :loading="busy"
        @click="act(cancelDemo)"
      />
    </template>

    <template v-else-if="run">
      <p class="demo-card__line" aria-live="polite">{{ outcomeLine }}</p>
      <p v-if="summaryLine" class="demo-card__line">{{ summaryLine }}</p>
      <p v-if="run.status === 'done' && run.error" class="demo-card__hint">{{ run.error }}</p>
      <div v-if="truth && truth.documents" class="demo-truth">
        <div class="demo-truth__head">
          <span class="demo-truth__title">Erkennung der Dokumente</span>
          <Button
            icon="pi pi-refresh"
            size="small"
            text
            rounded
            aria-label="Abgleich aktualisieren"
            :loading="truthLoading"
            @click="loadTruth"
          />
        </div>
        <p class="demo-card__hint">
          Was die Erkennung gefunden hat, verglichen mit dem, was der Generator weiß.
          <template v-if="truth.pending">Noch in Verarbeitung: {{ truth.pending }} von {{ truth.documents }}.</template>
          <template v-if="truth.failed">Fehlgeschlagen: {{ truth.failed }}.</template>
        </p>
        <table class="demo-truth__table">
          <tbody>
            <tr v-for="f in truth.fields" :key="f.field">
              <th scope="row">{{ FIELD_LABELS[f.field] }}</th>
              <td>{{ f.hits }} von {{ f.compared }}</td>
              <td class="demo-truth__pct">{{ percent(f.hits, f.compared) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Button
        v-if="run.status !== 'removing'"
        label="Demodaten entfernen"
        icon="pi pi-trash"
        size="small"
        severity="danger"
        outlined
        :loading="busy"
        @click="remove"
      />
    </template>

    <p v-if="error" class="demo-card__warn">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.demo-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-self: stretch;
}

.demo-section__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.demo-card {
  max-width: 32rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 0.85rem 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  background: var(--p-content-background);
}

.demo-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
}

.demo-card__desc {
  margin: 0;
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}

.demo-card__line {
  margin: 0;
  font-size: var(--text-base);
}

.demo-card__hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

.demo-card__option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-base);
}

.demo-truth {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.demo-truth__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.demo-truth__title {
  font-weight: 600;
}

.demo-truth__table {
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.demo-truth__table th,
.demo-truth__table td {
  padding: var(--space-1) var(--space-2) var(--space-1) 0;
  text-align: left;
  border-bottom: 1px solid var(--p-content-border-color);
}

.demo-truth__table th {
  font-weight: 500;
}

.demo-truth__pct {
  text-align: right;
  color: var(--p-text-muted-color);
}

.demo-card__warn {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--p-tag-warn-color);
}

.demo-card__bar {
  align-self: stretch;
  height: var(--space-2);
}
</style>
