<script setup lang="ts">
/**
 * The assistant benchmark on a button (documentation/plans/ki-assistent.md,
 * "Benchmark"). The cases run through the real agent loop against the model
 * llm-service has loaded; the results are kept per run, so switching the
 * model under "KI-Modell" and running again compares the two. A run can
 * also ask for the CPU twin of the loaded model: the GPU is lent for the
 * run, as the nightly aesthetic job does it, and handed back afterwards.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import { useConfirm } from 'primevue/useconfirm'
import PageLayout from '../components/layout/PageLayout.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import ScrollX from '../components/layout/ScrollX.vue'
import {
  cancelBenchRun,
  deleteBenchRun,
  deleteFeedback,
  getBenchRun,
  listBenchCases,
  listBenchRuns,
  listFeedback,
  startBenchRun,
  PHASE_LEND,
  PHASE_RETURN,
  type BenchCaseInfo,
  type FeedbackEntry,
  type BenchModel,
  type BenchCaseRun,
  type BenchRunDetail,
  type BenchRunSummary,
  type BenchStatus,
  type BenchSummary,
} from '../api/assistantBenchmark'

const POLL_MS = 2000

const confirm = useConfirm()
const cases = ref<BenchCaseInfo[]>([])
const today = ref('')
const runs = ref<BenchRunSummary[]>([])
const selected = ref<BenchRunDetail | null>(null)
const label = ref('')
const chosenCases = ref<string[]>([])
const onCpu = ref(false)
const loaded = ref(false)
const busy = ref<'start' | 'cancel' | null>(null)
const error = ref<string | null>(null)

const feedback = ref<FeedbackEntry[]>([])
const copiedDraft = ref<number | null>(null)

const running = computed(() => runs.value.find((r) => r.status === 'running') ?? null)
const caseTitle = (id: string | null) => cases.value.find((c) => c.id === id)?.title ?? id ?? ''

/** What a running run is doing right now, in words. */
function phaseText(run: BenchRunSummary): string {
  if (run.current_case === PHASE_LEND) return 'GPU wird verliehen, das Modell lädt auf der CPU'
  if (run.current_case === PHASE_RETURN) return 'GPU kommt zurück, das Modell lädt wieder auf der GPU'
  if (run.current_case) return `gerade „${caseTitle(run.current_case)}“`
  return ''
}

/** GPU or CPU, read from where the model's layers were. */
function device(model: BenchModel | null): string {
  if (!model || model.gpu_layers === undefined) return '–'
  return model.gpu_layers === 0 ? 'CPU' : 'GPU'
}
const caseOptions = computed(() => cases.value.map((c) => ({ value: c.id, label: c.title })))

const STATUS: Record<BenchStatus, { label: string; severity: 'info' | 'success' | 'danger' | 'secondary' }> = {
  running: { label: 'Läuft', severity: 'info' },
  done: { label: 'Fertig', severity: 'success' },
  failed: { label: 'Fehler', severity: 'danger' },
  cancelled: { label: 'Abgebrochen', severity: 'secondary' },
}

function percent(v: number | undefined | null): string {
  return v === null || v === undefined ? '–' : `${Math.round(v * 100)} %`
}

function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–'
  return v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
}

function callText(c: BenchCaseRun['calls'][number]): string {
  return `${c.tool}(${JSON.stringify(c.args)})`
}

/** The road a case took, in one line: first tool, nudges, prompt of round 1. */
const ROUTING_LABEL: Record<NonNullable<BenchCaseRun['routing']>, string> = {
  keywords: 'Stichwörter',
  inherited: 'vom Vortext',
  model: 'Modell',
  all: 'keine Entscheidung',
}

function routedText(routed: BenchSummary['routed']): string {
  if (!routed) return '–'
  const parts = (Object.keys(ROUTING_LABEL) as Array<keyof typeof ROUTING_LABEL>)
    .filter((k) => routed[k])
    .map((k) => `${ROUTING_LABEL[k]} ${routed[k]}`)
  return parts.join(' · ') || '–'
}

function roadText(r: BenchCaseRun): string {
  if (r.first_tool === undefined) return '–'
  const parts = [r.first_tool ?? 'kein Werkzeug']
  if (r.areas) parts.push(`${r.routing === 'all' ? 'alle Bereiche' : r.areas.join('+')} (${ROUTING_LABEL[r.routing ?? 'all']})`)
  if (r.nudges) parts.push(`${r.nudges}× zurück`)
  if (r.empty_results) parts.push(`${r.empty_followed ?? 0}/${r.empty_results} leere Ergebnisse weiterverfolgt`)
  if (r.tool_errors) parts.push(`${r.errors_corrected ?? 0}/${r.tool_errors} Fehler korrigiert`)
  if (r.plan) parts.push(`Plan ${r.plan_done ?? 0}/${r.plan.length}: ${r.plan.join(' → ')}`)
  else if (r.plan_asked) parts.push(r.plan_reply === 'tool_call' ? 'Plan erbeten, Modell rief stattdessen ein Werkzeug' : 'Plan erbeten, keiner geschrieben')
  if (r.follow_up) parts.push('Rückfrage')
  if (r.checks) parts.push(`Prüfer ${r.check_failed ?? 0}/${r.checks} Einwände${r.unverified ? ', Hinweis in der Antwort' : ''}`)
  if (r.prompt_tokens_first) parts.push(`${r.prompt_tokens_first} Tokens`)
  return parts.join(' · ')
}

async function refreshFeedback() {
  feedback.value = (await listFeedback()).entries
}

function traceText(t: FeedbackEntry['trace'][number]): string {
  const call = `${t.tool}(${JSON.stringify(t.arguments)})`
  if (t.error) return `${call} → ${t.error}`
  return t.rows === null ? call : `${call} · ${t.rows}`
}

async function copyDraft(entry: FeedbackEntry) {
  try {
    await navigator.clipboard.writeText(entry.case_draft)
    copiedDraft.value = entry.id
    setTimeout(() => { if (copiedDraft.value === entry.id) copiedDraft.value = null }, 2000)
  } catch {
    error.value = 'Der Fall konnte nicht in die Zwischenablage kopiert werden'
  }
}

function removeFeedback(entry: FeedbackEntry) {
  confirm.require({
    message: `Die Rückmeldung vom ${when(entry.created_at)} zur Frage „${entry.question.slice(0, 60)}“ löschen?`,
    header: 'Rückmeldung löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteFeedback(entry.id)
        await refreshFeedback()
      } catch (e) {
        error.value = message(e, 'Die Rückmeldung konnte nicht gelöscht werden')
      }
    },
  })
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

async function refreshRuns() {
  runs.value = (await listBenchRuns()).runs
}

async function select(id: number) {
  try {
    selected.value = await getBenchRun(id)
  } catch (e) {
    error.value = message(e, 'Der Lauf konnte nicht geladen werden')
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

function schedulePoll() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void poll(), POLL_MS)
}

/** While a run is going, follow it; when it ends, the history shows its numbers. */
async function poll() {
  timer = null
  try {
    await refreshRuns()
    const current = running.value
    if (current && (!selected.value || selected.value.id === current.id || selected.value.status !== 'running')) {
      await select(current.id)
    } else if (selected.value?.status === 'running') {
      await select(selected.value.id)
    }
  } catch (e) {
    error.value = message(e, 'Der Stand konnte nicht geladen werden')
  }
  if (running.value || selected.value?.status === 'running') schedulePoll()
}

onMounted(async () => {
  try {
    const [c] = await Promise.all([listBenchCases(), refreshRuns(), refreshFeedback()])
    cases.value = c.cases
    today.value = c.today
    const first = running.value ?? runs.value[0]
    if (first) await select(first.id)
  } catch (e) {
    error.value = message(e, 'Der Benchmark konnte nicht geladen werden')
  } finally {
    loaded.value = true
  }
  if (running.value) schedulePoll()
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

async function start() {
  busy.value = 'start'
  error.value = null
  try {
    const run = await startBenchRun({
      label: label.value.trim() || undefined,
      case_ids: chosenCases.value.length ? chosenCases.value : undefined,
      device: onCpu.value ? 'cpu' : 'loaded',
    })
    selected.value = run
    await refreshRuns()
    schedulePoll()
  } catch (e) {
    error.value = message(e, 'Der Benchmark konnte nicht gestartet werden')
  } finally {
    busy.value = null
  }
}

async function cancel() {
  const run = running.value
  if (!run) return
  busy.value = 'cancel'
  try {
    await cancelBenchRun(run.id)
    await refreshRuns()
    await select(run.id)
  } catch (e) {
    error.value = message(e, 'Der Lauf konnte nicht abgebrochen werden')
  } finally {
    busy.value = null
  }
}

function remove(run: BenchRunSummary) {
  confirm.require({
    message: `Den Lauf „${run.label}“ vom ${when(run.started_at)} mit allen Ergebnissen löschen?`,
    header: 'Lauf löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteBenchRun(run.id)
        if (selected.value?.id === run.id) selected.value = null
        await refreshRuns()
      } catch (e) {
        error.value = message(e, 'Der Lauf konnte nicht gelöscht werden')
      }
    },
  })
}
</script>

<template>
  <PageLayout
    title="KI-Benchmark"
    hint="Prüft, ob das geladene Modell für typische Fragen die richtigen Werkzeuge mit den richtigen Argumenten wählt, und misst die Zeit je Runde – auf der GPU oder auf dem CPU-Zwilling."
    width="wide"
    :ready="loaded"
  >
    <template #notice>
      <ErrorBanner v-if="error" :message="error" :retryable="false" closable @close="error = null" />
    </template>

    <div class="bench">
      <section class="card" aria-labelledby="bench-start">
        <h2 id="bench-start" class="card-title">Neuer Lauf</h2>
        <p class="muted">
          {{ cases.length }} Fälle laufen nacheinander durch die echte Agent-Schleife des Assistenten – mit dem
          echten Systemprompt und Werkzeugkatalog, aber mit festen, erfundenen Werkzeugergebnissen und
          dem festen Datum {{ today }}. Es werden keine Daten gelesen oder geändert. Jede Runde wartet
          im KI-Slot hinter den Fragen der Nutzer; gemessen wird nur die Zeit des Modells. Zum Vergleich:
          unter <em>KI-Modell</em> ein anderes Modell aktivieren und erneut laufen lassen, oder denselben
          Lauf auf dem CPU-Zwilling starten – so läuft das Modell nachts, wenn die GPU die Fotos bewertet.
        </p>

        <div v-if="running" class="progress" aria-live="polite">
          <div class="progress-head">
            <span>
              Lauf „{{ running.label }}“: {{ running.cases_done }} von {{ running.cases_total }} Fällen
              <template v-if="phaseText(running)"> – {{ phaseText(running) }}</template>
            </span>
            <Button
              label="Abbrechen"
              icon="pi pi-stop"
              severity="secondary"
              size="small"
              :loading="busy === 'cancel'"
              @click="cancel"
            />
          </div>
          <ProgressBar
            :value="Math.round((running.cases_done / Math.max(1, running.cases_total)) * 100)"
            :aria-label="`${running.cases_done} von ${running.cases_total} Fällen`"
          />
        </div>

        <div v-else class="form">
          <div class="field">
            <label for="bench-label">Bezeichnung</label>
            <InputText id="bench-label" v-model="label" placeholder="Standard: das geladene Modell" />
          </div>
          <div class="field">
            <label for="bench-cases">Fälle</label>
            <MultiSelect
              v-model="chosenCases"
              input-id="bench-cases"
              :options="caseOptions"
              option-label="label"
              option-value="value"
              placeholder="Alle Fälle"
              filter
              :max-selected-labels="2"
              selected-items-label="{0} Fälle"
            />
          </div>
          <div class="field field-check">
            <Checkbox v-model="onCpu" input-id="bench-cpu" binary />
            <label for="bench-cpu">Auf dem CPU-Zwilling messen (GPU wird für den Lauf verliehen)</label>
          </div>
          <Button
            label="Benchmark starten"
            icon="pi pi-play"
            class="start"
            :loading="busy === 'start'"
            :disabled="!cases.length"
            @click="start"
          />
        </div>
      </section>

      <section v-if="selected" class="card" aria-labelledby="bench-result">
        <header class="result-head">
          <h2 id="bench-result" class="card-title">Lauf „{{ selected.label }}“</h2>
          <Tag :value="STATUS[selected.status].label" :severity="STATUS[selected.status].severity" />
        </header>
        <p class="muted">
          Gestartet {{ when(selected.started_at) }}<template v-if="selected.model">
            · {{ selected.model.model_filename }} · {{ selected.model.backend }} · Kontext {{ selected.model.ctx_size }}<template v-if="selected.model.gpu_layers !== undefined"> · {{ device(selected.model) }}</template></template>
        </p>
        <p v-if="selected.error" class="failure" role="alert">{{ selected.error }}</p>

        <dl v-if="selected.summary" class="tiles">
          <div class="tile"><dt>Bestanden</dt><dd>{{ selected.summary.passed }} / {{ selected.summary.cases }}</dd></div>
          <div class="tile"><dt>Richtiges Werkzeug</dt><dd>{{ percent(selected.summary.tool_hit_rate) }}</dd></div>
          <div class="tile"><dt>Richtige Argumente</dt><dd>{{ percent(selected.summary.args_hit_rate) }}</dd></div>
          <div class="tile"><dt>Median je Runde</dt><dd>{{ ms(selected.summary.median_ms_per_round) }}</dd></div>
          <div class="tile"><dt>p90 je Runde</dt><dd>{{ ms(selected.summary.p90_ms_per_round) }}</dd></div>
          <div class="tile">
            <dt>Runden je Fall</dt>
            <dd>{{ selected.summary.median_rounds_per_case ?? '–' }} (max. {{ selected.summary.max_rounds_used ?? '–' }})</dd>
          </div>
          <div class="tile"><dt>Erstes Werkzeug richtig</dt><dd>{{ percent(selected.summary.first_tool_hit_rate) }}</dd></div>
          <div class="tile"><dt>Zurückgeschickt</dt><dd>{{ selected.summary.nudges ?? '–' }}</dd></div>
          <div class="tile"><dt>Prompt Runde 1 (Median)</dt><dd>{{ selected.summary.median_prompt_tokens_first ?? '–' }}</dd></div>
          <div class="tile"><dt>Bereiche gewählt durch</dt><dd>{{ routedText(selected.summary.routed) }}</dd></div>
          <div class="tile"><dt>Leere Ergebnisse weiterverfolgt</dt><dd>{{ percent(selected.summary.empty_follow_rate) }}</dd></div>
          <div class="tile"><dt>Fehler korrigiert</dt><dd>{{ percent(selected.summary.error_fix_rate) }}</dd></div>
          <div class="tile"><dt>Mehrbereichsfälle bestanden</dt><dd>{{ percent(selected.summary.multi_area_pass_rate) }}</dd></div>
          <div class="tile"><dt>Rückfragen bestanden</dt><dd>{{ percent(selected.summary.follow_up_pass_rate) }}</dd></div>
          <div class="tile">
            <dt>Prüfer-Einwände</dt>
            <dd>{{ selected.summary.check_failed ?? '–' }} / {{ selected.summary.checks ?? '–' }} (ungeprüft ausgeliefert {{ selected.summary.unverified ?? '–' }}, {{ selected.summary.median_check_ms != null ? `${Math.round(selected.summary.median_check_ms)} ms` : '–' }})</dd>
          </div>
          <div class="tile">
            <dt>Mit Plan</dt>
            <dd>{{ selected.summary.planned ?? '–' }} / {{ selected.summary.plan_asked ?? '–' }} (Runden-Median {{ selected.summary.median_rounds_multi_area ?? '–' }})</dd>
          </div>
        </dl>

        <ScrollX v-if="selected.results.length">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Fall</th>
                <th scope="col">Ergebnis</th>
                <th scope="col">Runden</th>
                <th scope="col">Weg</th>
                <th scope="col">Aufrufe</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in selected.results" :key="r.id">
                <td class="case">
                  <span class="case-title">{{ r.title }}</span>
                  <span class="muted case-id">{{ r.id }}</span>
                </td>
                <td>
                  <Tag :value="r.score.passed ? 'bestanden' : 'nicht bestanden'" :severity="r.score.passed ? 'success' : 'danger'" />
                  <div v-if="r.error" class="failure">{{ r.error }}</div>
                  <div v-else-if="r.score.missing.length" class="muted">fehlt: {{ r.score.missing.join(', ') }}</div>
                  <div v-else-if="!r.score.answered" class="muted">keine Antwort</div>
                </td>
                <td class="num">{{ r.rounds_ms.length }} · {{ r.rounds_ms.map((x) => ms(x)).join(' / ') }}</td>
                <td :class="['road', { 'road--wrong': r.score.first_tool_hit === false }]">{{ roadText(r) }}</td>
                <td class="calls">
                  <code v-for="(c, i) in r.calls" :key="i" class="call">{{ callText(c) }}</code>
                  <span v-if="!r.calls.length" class="muted">keine</span>
                  <details v-if="r.answer" class="answer">
                    <summary>Antwort</summary>
                    <p>{{ r.answer }}</p>
                  </details>
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <section class="card" aria-labelledby="bench-history">
        <h2 id="bench-history" class="card-title">Verlauf</h2>
        <EmptyState
          v-if="!runs.length"
          icon="pi pi-chart-bar"
          title="Noch kein Lauf"
          message="Der erste Lauf erscheint hier, sobald er gestartet ist."
        />
        <ScrollX v-else>
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Gestartet</th>
                <th scope="col">Bezeichnung</th>
                <th scope="col">Status</th>
                <th scope="col">Gerät</th>
                <th scope="col" class="num">Bestanden</th>
                <th scope="col" class="num">Werkzeug</th>
                <th scope="col" class="num">Argumente</th>
                <th scope="col" class="num">Median</th>
                <th scope="col" class="num">p90</th>
                <th scope="col"><span class="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in runs" :key="r.id" :class="{ 'row-selected': selected?.id === r.id }">
                <td>{{ when(r.started_at) }}</td>
                <td>
                  <button type="button" class="link" @click="select(r.id)">{{ r.label }}</button>
                </td>
                <td><Tag :value="STATUS[r.status].label" :severity="STATUS[r.status].severity" /></td>
                <td>{{ device(r.model) }}</td>
                <td class="num">{{ r.summary ? `${r.summary.passed} / ${r.summary.cases}` : `${r.cases_done} / ${r.cases_total}` }}</td>
                <td class="num">{{ percent(r.summary?.tool_hit_rate) }}</td>
                <td class="num">{{ percent(r.summary?.args_hit_rate) }}</td>
                <td class="num">{{ ms(r.summary?.median_ms_per_round) }}</td>
                <td class="num">{{ ms(r.summary?.p90_ms_per_round) }}</td>
                <td>
                  <Button
                    icon="pi pi-trash"
                    text
                    rounded
                    severity="secondary"
                    size="small"
                    :aria-label="`Lauf ${r.label} löschen`"
                    :disabled="r.status === 'running'"
                    @click="remove(r)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>

      <section class="card" aria-labelledby="bench-feedback">
        <h2 id="bench-feedback" class="card-title">Rückmeldungen aus dem Alltag</h2>
        <p class="muted">
          Was Nutzer unter einer Antwort mit Daumen hoch oder runter bewertet haben: die Frage, der Weg
          des Modells (Werkzeuge, Argumente, Trefferzahl, Fehler – nie die Zeilen selbst) und die Antwort.
          „Als Fall kopieren“ legt ein Fallgerüst für <code>bench/cases.ts</code> in die Zwischenablage;
          vor dem Einfügen jeden echten Namen, jede Nummer und jeden Betrag durch erfundene ersetzen.
        </p>
        <p v-if="!feedback.length" class="muted">Noch keine Rückmeldungen.</p>
        <ul v-else class="feedback-list">
          <li v-for="f in feedback" :key="f.id" class="feedback">
            <div class="feedback-head">
              <Tag :value="f.verdict === 'down' ? 'Daumen runter' : 'Daumen hoch'" :severity="f.verdict === 'down' ? 'danger' : 'success'" />
              <span class="muted">{{ when(f.created_at) }}</span>
              <span class="spacer" />
              <Button
                :icon="copiedDraft === f.id ? 'pi pi-check' : 'pi pi-copy'"
                :label="copiedDraft === f.id ? 'Kopiert' : 'Als Fall kopieren'"
                text
                size="small"
                severity="secondary"
                @click="copyDraft(f)"
              />
              <Button
                icon="pi pi-trash"
                text
                rounded
                severity="secondary"
                size="small"
                aria-label="Rückmeldung löschen"
                @click="removeFeedback(f)"
              />
            </div>
            <p class="feedback-question">{{ f.question }}</p>
            <p v-if="f.comment" class="feedback-comment">„{{ f.comment }}“</p>
            <div class="calls">
              <code v-for="(t, i) in f.trace" :key="i" :class="['call', { 'call--failed': !!t.error }]">{{ traceText(t) }}</code>
              <span v-if="!f.trace.length" class="muted">kein Werkzeug</span>
            </div>
            <details class="answer">
              <summary>Antwort</summary>
              <p>{{ f.answer }}</p>
            </details>
          </li>
        </ul>
      </section>
    </div>
  </PageLayout>
</template>

<style scoped>
.bench {
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

.card-title {
  margin: 0;
  font-size: var(--text-lg);
}

.muted {
  margin: 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}

.form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 14rem;
  min-width: 0;
}

.field label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

.field-check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
  flex-basis: 100%;
}

.field-check label {
  color: var(--p-text-color);
}

.progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.progress-head {
  font-size: var(--text-sm);
}

.progress-head,
.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
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

/* Wide enough to read on a phone; ScrollX scrolls the rest. */
.case {
  min-width: 10rem;
}

.road {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.road--wrong {
  color: var(--p-red-600);
}

.feedback-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.feedback {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--p-content-border-color);
}

.feedback-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.feedback-question,
.feedback-comment {
  margin: 0;
  overflow-wrap: anywhere;
}

.feedback-comment {
  color: var(--p-text-muted-color);
}

.call--failed {
  color: var(--p-red-600);
}

.calls {
  min-width: 18rem;
}

.case-title {
  display: block;
}

.case-id {
  display: block;
  font-size: var(--text-xs);
}

.call {
  display: block;
  max-width: 32rem;
  overflow-wrap: anywhere;
  font-size: var(--text-xs);
}

.answer summary {
  cursor: pointer;
  color: var(--p-primary-color);
}

.answer p {
  margin: var(--space-1) 0 0;
  white-space: pre-wrap;
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
