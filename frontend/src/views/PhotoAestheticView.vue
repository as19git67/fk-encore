<script setup lang="ts">
/**
 * Fotos › Einstellungen › Ästhetik (documentation/plans/foto-aesthetik.md,
 * stage 3). At night the GPU is lent to Q-Align, which scores how good a
 * photo looks; Gemma keeps answering on the CPU meanwhile. The page sets the
 * window, shows how far the library is, follows a running night and keeps
 * the history; an admin can start a run outside the window or stop one.
 * Stage 4 adds the provisional head: learnt from the night's scores, it
 * gives new photos a value at import and shows how close it gets.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import ToggleSwitch from 'primevue/toggleswitch'
import { useConfirm } from 'primevue/useconfirm'
import PageLayout from '../components/layout/PageLayout.vue'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import EmptyState from '../components/layout/EmptyState.vue'
import ScrollX from '../components/layout/ScrollX.vue'
import {
  backfillAesthetic,
  clearAestheticRuns,
  deleteAestheticRun,
  getAestheticOverview,
  saveAestheticSettings,
  startAestheticRun,
  stopAestheticRun,
  trainAestheticHead,
  replayAutoPick,
  adoptAutoPickReplay,
  replayCompositeScore,
  adoptCompositeScore,
  resetCompositeScore,
  type CompositeReport,
  type CompositeWeights,
  type ReplayReport,
  type AestheticHeadJob,
  type AestheticOverview,
  type AestheticRun,
  type AestheticRunStatus,
  type ScorerStatus,
} from '../api/photoAesthetic'

const POLL_MS = 5000

const confirm = useConfirm()
const overview = ref<AestheticOverview | null>(null)
const loaded = ref(false)
const error = ref<string | null>(null)
const info = ref<string | null>(null)
const busy = ref<
  'save' | 'start' | 'stop' | 'backfill' | 'train' | 'clear' | 'replay' | 'adopt' | 'composite' | 'composite-adopt' | 'composite-reset' | number | null
>(null)
const replay = ref<ReplayReport | null>(null)
const composite = ref<CompositeReport | null>(null)

const enabled = ref(false)
const windowStart = ref('01:00')
const windowEnd = ref('06:00')

const running = computed<AestheticRun | null>(() => overview.value?.runs.find((r) => r.status === 'running') ?? null)
const headJob = computed<AestheticHeadJob | null>(() => overview.value?.head_job ?? null)
const headBusy = computed(() => headJob.value?.status === 'running')
/** Something on the page is moving: follow it. */
const live = computed(() => !!running.value || headBusy.value)
const dirty = computed(() => {
  const s = overview.value?.settings
  return !!s && (s.enabled !== enabled.value || s.window_start !== windowStart.value || s.window_end !== windowEnd.value)
})
/** Finished runs that owe nothing; only these can be deleted (a stranded run is still recovered). */
const deletable = (r: AestheticRun) => r.status !== 'running' && r.gpu_returned
const anyDeletable = computed(() => !!overview.value?.runs.some(deletable))
const total = computed(() => (overview.value ? overview.value.scored + overview.value.backlog : 0))
const share = computed(() => (total.value ? Math.round((overview.value!.scored / total.value) * 100) : 0))

const PHASES: Record<string, string> = {
  start: 'startet',
  'gpu:lend': 'GPU wird verliehen, Gemma lädt auf der CPU',
  'scorer:load': 'Q-Align lädt auf der GPU – beim ersten Mal mit Download',
  scoring: 'bewertet Fotos',
  'scorer:unload': 'Q-Align wird entladen',
  'gpu:return': 'GPU kommt zurück, Gemma lädt wieder auf der GPU',
}

const STATUS: Record<AestheticRunStatus, { label: string; severity: 'info' | 'success' | 'danger' | 'secondary' }> = {
  running: { label: 'Läuft', severity: 'info' },
  done: { label: 'Fertig', severity: 'success' },
  stopped: { label: 'Angehalten', severity: 'secondary' },
  failed: { label: 'Fehler', severity: 'danger' },
}

function scorerText(s: ScorerStatus | null, problem: string | null): string {
  if (!s) return problem ? 'nicht erreichbar' : '–'
  switch (s.state) {
    case 'unloaded':
      return 'nicht geladen'
    case 'loading':
      return 'lädt'
    case 'loaded':
      return 'geladen'
    case 'unloading':
      return 'entlädt'
    case 'error':
      return 'Fehler'
  }
  return s.state
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
}

function duration(run: AestheticRun): string {
  const end = run.ended_at ? Date.parse(run.ended_at) : Date.now()
  const minutes = Math.max(0, Math.round((end - Date.parse(run.started_at)) / 60_000))
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function count(n: number): string {
  return n.toLocaleString('de-DE')
}

function rho(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function headJobText(job: AestheticHeadJob): string {
  const by = job.trigger === 'manual' ? 'Von Hand' : 'Nach dem Nachtlauf'
  if (job.status === 'running') {
    return job.phase === 'apply'
      ? `${by}: überträgt auf die Fotos, ${count(job.applied)} bisher`
      : `${by}: lernt aus den Q-Align-Werten`
  }
  if (job.status === 'failed') return `${by} fehlgeschlagen: ${job.error ?? 'unbekannt'}`
  if (job.status === 'skipped') return `${by}: ${job.note ?? 'nichts zu tun'}`
  const missing = job.without_vector ? `, ${count(job.without_vector)} noch ohne CLIP-Vektor` : ''
  return `${by}: ${count(job.applied)} Fotos vorläufig bewertet${missing}`
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

function adopt(o: AestheticOverview, resetForm: boolean) {
  overview.value = o
  if (resetForm) {
    enabled.value = o.settings.enabled
    windowStart.value = o.settings.window_start
    windowEnd.value = o.settings.window_end
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

function schedulePoll() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void refresh(), POLL_MS)
}

async function refresh() {
  timer = null
  try {
    adopt(await getAestheticOverview(), !dirty.value)
  } catch (e) {
    error.value = message(e, 'Der Stand konnte nicht geladen werden')
  }
  if (live.value) schedulePoll()
}

onMounted(async () => {
  try {
    adopt(await getAestheticOverview(), true)
  } catch (e) {
    error.value = message(e, 'Die Ästhetik-Bewertung konnte nicht geladen werden')
  } finally {
    loaded.value = true
  }
  if (live.value) schedulePoll()
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

async function save() {
  busy.value = 'save'
  error.value = null
  try {
    await saveAestheticSettings({ enabled: enabled.value, window_start: windowStart.value, window_end: windowEnd.value })
    adopt(await getAestheticOverview(), true)
    info.value = 'Gespeichert.'
  } catch (e) {
    error.value = message(e, 'Die Einstellungen konnten nicht gespeichert werden')
  } finally {
    busy.value = null
  }
}

async function start() {
  busy.value = 'start'
  error.value = null
  info.value = null
  try {
    const result = await startAestheticRun()
    if (!result.started) info.value = `Nicht gestartet: ${result.reason}.`
    adopt(await getAestheticOverview(), false)
    if (running.value) schedulePoll()
  } catch (e) {
    error.value = message(e, 'Der Lauf konnte nicht gestartet werden')
  } finally {
    busy.value = null
  }
}

async function stop() {
  busy.value = 'stop'
  try {
    await stopAestheticRun()
    info.value = 'Der Lauf hält nach dem aktuellen Foto an und gibt die GPU zurück.'
    await refresh()
  } catch (e) {
    error.value = message(e, 'Der Lauf konnte nicht angehalten werden')
  } finally {
    busy.value = null
  }
}

async function train() {
  busy.value = 'train'
  error.value = null
  info.value = null
  try {
    const { started } = await trainAestheticHead()
    if (!started) info.value = 'Es lernt gerade schon.'
    adopt(await getAestheticOverview(), false)
    if (live.value) schedulePoll()
  } catch (e) {
    error.value = message(e, 'Das Training konnte nicht gestartet werden')
  } finally {
    busy.value = null
  }
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)} %`
}

async function runReplay() {
  busy.value = 'replay'
  error.value = null
  info.value = null
  try {
    replay.value = await replayAutoPick()
  } catch (e) {
    error.value = message(e, 'Das Nachspielen ist fehlgeschlagen')
  } finally {
    busy.value = null
  }
}

const recommendedVariant = computed(() =>
  replay.value?.variants.find((v) => v.key === replay.value?.recommended) ?? null,
)

function adoptReplay() {
  const r = replay.value
  const best = recommendedVariant.value
  const today = r?.variants.find((v) => v.key === 'current')
  if (!r || !best || !today) return
  confirm.require({
    message:
      `Die Gewichte „${best.label}“ für deinen Auto-Pick übernehmen? Sie treffen deine Wahl in ${percent(best.hit_rate)} ` +
      `statt ${percent(today.hit_rate)} der Gruppen. Die offenen Gruppen werden danach neu bewertet.`,
    header: 'Gewichte übernehmen',
    icon: 'pi pi-check',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Übernehmen',
    accept: async () => {
      busy.value = 'adopt'
      try {
        await adoptAutoPickReplay()
        info.value = 'Übernommen. Die offenen Gruppen werden im Hintergrund neu bewertet.'
        replay.value = await replayAutoPick()
      } catch (e) {
        error.value = message(e, 'Die Gewichte konnten nicht übernommen werden')
      } finally {
        busy.value = null
      }
    },
  })
}

// ─── The overall score without the CLIP prompts ─────────────────────────────

/** "45 % Ästhetik · 25 % Technik · 30 % Schärfe", or the original formula. */
function weightsText(w: CompositeWeights | null): string {
  if (!w) return 'bisherige Formel mit CLIP'
  return `${percent(w.aesthetics)} Ästhetik · ${percent(w.quality)} Technik · ${percent(w.blur)} Schärfe`
}

async function runComposite() {
  busy.value = 'composite'
  error.value = null
  info.value = null
  try {
    composite.value = await replayCompositeScore()
  } catch (e) {
    error.value = message(e, 'Das Nachspielen ist fehlgeschlagen')
  } finally {
    busy.value = null
  }
}

const compositeRecommended = computed(() =>
  composite.value?.variants.find((v) => v.key === composite.value?.recommended) ?? null,
)

function adoptComposite() {
  const r = composite.value
  const best = compositeRecommended.value
  const today = r?.variants.find((v) => v.key === 'current')
  if (!r || !best || !today) return
  confirm.require({
    message:
      `Die Gesamtnote „${best.label}“ (${weightsText(best.weights)}) für alle Fotos mit Q-Align-Wert übernehmen? ` +
      `Sie trifft eure Wahl in ${percent(best.hit_rate)} statt ${percent(today.hit_rate)} der Gruppen. ` +
      `Filter und Sortierung „Qualität“ ändern sich damit.`,
    header: 'Gesamtnote übernehmen',
    icon: 'pi pi-check',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Übernehmen',
    accept: async () => {
      busy.value = 'composite-adopt'
      try {
        composite.value = await adoptCompositeScore()
        info.value = 'Übernommen. Die Gesamtnoten werden im Hintergrund neu berechnet.'
        adopt(await getAestheticOverview(), false)
      } catch (e) {
        error.value = message(e, 'Die Gesamtnote konnte nicht übernommen werden')
      } finally {
        busy.value = null
      }
    },
  })
}

function resetComposite() {
  confirm.require({
    message: 'Zur bisherigen Formel mit den CLIP-Werten zurückkehren? Die Gesamtnoten werden neu berechnet.',
    header: 'Bisherige Formel',
    icon: 'pi pi-undo',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Zurücksetzen',
    accept: async () => {
      busy.value = 'composite-reset'
      try {
        await resetCompositeScore()
        info.value = 'Zurückgesetzt. Die Gesamtnoten werden im Hintergrund neu berechnet.'
        composite.value = null
        adopt(await getAestheticOverview(), false)
      } catch (e) {
        error.value = message(e, 'Das Zurücksetzen ist fehlgeschlagen')
      } finally {
        busy.value = null
      }
    },
  })
}

function deleteRun(r: AestheticRun) {
  confirm.require({
    message: `Den Lauf vom ${when(r.started_at)} aus dem Verlauf löschen? Die Bewertungen der Fotos bleiben.`,
    header: 'Lauf löschen',
    icon: 'pi pi-trash',
    rejectLabel: 'Abbrechen',
    acceptProps: { label: 'Löschen', severity: 'danger' },
    accept: async () => {
      busy.value = r.id
      try {
        await deleteAestheticRun(r.id)
        await refresh()
      } catch (e) {
        error.value = message(e, 'Der Lauf konnte nicht gelöscht werden')
      } finally {
        busy.value = null
      }
    },
  })
}

function clearRuns() {
  confirm.require({
    message:
      'Alle beendeten Läufe aus dem Verlauf löschen? Die Bewertungen der Fotos bleiben; ein laufender Lauf und einer, der die GPU noch nicht zurückgegeben hat, bleiben stehen.',
    header: 'Verlauf leeren',
    icon: 'pi pi-trash',
    rejectLabel: 'Abbrechen',
    acceptProps: { label: 'Alle löschen', severity: 'danger' },
    accept: async () => {
      busy.value = 'clear'
      try {
        const { deleted } = await clearAestheticRuns()
        info.value = deleted === 1 ? 'Ein Lauf gelöscht.' : `${count(deleted)} Läufe gelöscht.`
        await refresh()
      } catch (e) {
        error.value = message(e, 'Der Verlauf konnte nicht geleert werden')
      } finally {
        busy.value = null
      }
    },
  })
}

function rescoreAll() {
  const o = overview.value
  if (!o) return
  confirm.require({
    message: `Die ${count(o.scored)} mit ${o.model} bewerteten Fotos beim nächsten Lauf neu bewerten? Bis dahin behalten sie ihre jetzigen Werte.`,
    header: 'Neu bewerten',
    icon: 'pi pi-refresh',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Neu bewerten',
    accept: async () => {
      busy.value = 'backfill'
      try {
        const { marked } = await backfillAesthetic(o.model)
        info.value = `${count(marked)} Fotos kommen beim nächsten Lauf wieder dran.`
        await refresh()
      } catch (e) {
        error.value = message(e, 'Die Fotos konnten nicht zurückgesetzt werden')
      } finally {
        busy.value = null
      }
    },
  })
}
</script>

<template>
  <PageLayout
    title="Ästhetik"
    hint="Nachts leiht sich Q-Align die GPU und bewertet, wie gut ein Foto aussieht. Gemma antwortet solange auf der CPU, nur langsamer."
    width="wide"
    :ready="loaded"
  >
    <template #notice>
      <ErrorBanner v-if="error" :message="error" :retryable="false" closable @close="error = null" />
    </template>

    <div v-if="overview" class="aesthetic">
      <Message v-if="info" severity="info" closable @close="info = null">{{ info }}</Message>

      <section class="card" aria-labelledby="ae-state">
        <h2 id="ae-state" class="card-title">Stand</h2>
        <dl class="tiles">
          <div class="tile"><dt>Bewertet</dt><dd>{{ count(overview.scored) }}</dd></div>
          <div class="tile"><dt>Offen</dt><dd>{{ count(overview.backlog) }}</dd></div>
          <div class="tile"><dt>Bibliothek</dt><dd>{{ share }} %</dd></div>
          <div class="tile">
            <dt>Scorer</dt>
            <dd :title="overview.scorer?.error ?? overview.scorer_error ?? undefined">{{ scorerText(overview.scorer, overview.scorer_error) }}</dd>
          </div>
        </dl>
        <p v-if="overview.scorer?.state === 'error'" class="failure">{{ overview.scorer.error }}</p>
        <p v-else-if="!overview.scorer && overview.scorer_error" class="muted">
          Der Ästhetik-Dienst antwortet nicht. Läuft der Container <code>aesthetic_service</code>?
        </p>

        <div v-if="running" class="progress" aria-live="polite">
          <div class="progress-head">
            <span>
              {{ running.trigger === 'manual' ? 'Von Hand gestartet' : 'Nachtlauf' }} seit {{ duration(running) }}:
              {{ count(running.scored) }} bewertet<template v-if="running.failed">, {{ count(running.failed) }} nicht lesbar</template>
              <template v-if="running.phase"> – {{ PHASES[running.phase] ?? running.phase }}</template>
            </span>
            <Button
              label="Anhalten"
              icon="pi pi-stop"
              severity="secondary"
              size="small"
              :loading="busy === 'stop'"
              @click="stop"
            />
          </div>
          <ProgressBar
            :value="Math.round((running.scored / Math.max(1, running.backlog)) * 100)"
            :aria-label="`${running.scored} von ${running.backlog} Fotos dieses Laufs`"
          />
        </div>

        <div v-else class="buttons">
          <Button
            label="Jetzt starten"
            icon="pi pi-play"
            :loading="busy === 'start'"
            :disabled="overview.backlog === 0"
            @click="start"
          />
          <Button
            label="Alle neu bewerten"
            icon="pi pi-refresh"
            severity="secondary"
            outlined
            :loading="busy === 'backfill'"
            :disabled="overview.scored === 0"
            @click="rescoreAll"
          />
        </div>
        <p v-if="!running" class="muted">
          „Jetzt starten“ verleiht die GPU sofort, auch außerhalb des Fensters, und läuft, bis alle Fotos bewertet sind
          oder du anhältst.
        </p>
      </section>

      <section class="card" aria-labelledby="ae-head">
        <h2 id="ae-head" class="card-title">Vorläufiger Wert</h2>
        <p class="muted">
          Ein neues Foto wartet nicht bis zur Nacht: aus den Q-Align-Werten lernt die App, den Wert aus dem CLIP-Vektor zu
          schätzen, den der Embedding-Dienst ohnehin berechnet. Nachts ersetzt Q-Align die Schätzung.
        </p>
        <p v-if="overview.head_error" class="failure">Der Embedding-Dienst antwortet nicht: {{ overview.head_error }}</p>
        <template v-else-if="overview.head">
          <dl class="tiles">
            <div class="tile">
              <dt>Status</dt>
              <dd>{{ overview.head.active ? 'in Gebrauch' : 'ungenutzt' }}</dd>
            </div>
            <div class="tile">
              <dt>Trifft Q-Align</dt>
              <dd>{{ rho(overview.head.spearman_head) }}</dd>
            </div>
            <div class="tile">
              <dt>CLIP bisher</dt>
              <dd>{{ rho(overview.head.spearman_zero_shot) }}</dd>
            </div>
            <div class="tile">
              <dt>Gelernt aus</dt>
              <dd>{{ count(overview.head.samples) }}</dd>
            </div>
            <div v-if="overview.head.active && overview.head_pending !== null" class="tile">
              <dt>Noch ohne Wert</dt>
              <dd>{{ count(overview.head_pending) }}</dd>
            </div>
          </dl>
          <p class="muted">
            Rangkorrelation mit Q-Align auf {{ count(overview.head.test) }} zurückgehaltenen Fotos (1 = gleiche
            Reihenfolge), trainiert am {{ when(overview.head.trained_at) }}.
            <template v-if="!overview.head.active">
              Der Kopf ist nicht besser als die bisherige CLIP-Schätzung und bleibt deshalb unbenutzt.
            </template>
          </p>
        </template>
        <p v-else class="muted">
          Noch nicht trainiert. Das geschieht nach dem ersten Lauf, sobald 500 Fotos einen Q-Align-Wert haben.
        </p>
        <p v-if="headJob" class="muted" aria-live="polite" :class="{ failure: headJob.status === 'failed' }">
          {{ headJobText(headJob) }}
        </p>
        <div class="buttons">
          <Button
            label="Neu trainieren"
            icon="pi pi-sync"
            severity="secondary"
            outlined
            :loading="busy === 'train' || headBusy"
            :disabled="overview.scored === 0 || headBusy"
            @click="train"
          />
        </div>
      </section>

      <section class="card" aria-labelledby="ae-replay">
        <h2 id="ae-replay" class="card-title">Auto-Pick nachspielen</h2>
        <p class="muted">
          Spielt deine bereits geprüften Fotogruppen noch einmal durch: Wie oft hätte der Auto-Pick das Foto vorne, das du
          behalten hast? Neu gelernte Gewichte werden an Gruppen gemessen, aus denen sie nicht gelernt haben. Übernehmen
          lässt sich nur, was spürbar öfter trifft als heute.
        </p>
        <template v-if="replay">
          <p class="muted">
            {{ count(replay.qalign_groups) }} von {{ count(replay.decided_groups) }} entschiedenen Gruppen haben durchgehend
            Q-Align-Werte und zählen.
          </p>
          <ScrollX v-if="replay.qalign_groups > 0">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Gewichte</th>
                  <th scope="col" class="num">Trifft deine Wahl</th>
                  <th scope="col" class="num">Gruppen</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="v in replay.variants" :key="v.key">
                  <td>
                    {{ v.label }}
                    <Tag v-if="v.key === replay.recommended" value="Empfohlen" severity="success" />
                  </td>
                  <td class="num">{{ percent(v.hit_rate) }}</td>
                  <td class="num">{{ count(v.hits) }} / {{ count(v.groups) }}</td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
          <p v-if="replay.reason" class="muted">{{ replay.reason }}</p>
        </template>
        <div class="buttons">
          <Button
            label="Nachspielen"
            icon="pi pi-replay"
            severity="secondary"
            outlined
            :loading="busy === 'replay'"
            @click="runReplay"
          />
          <Button
            v-if="recommendedVariant"
            label="Gewichte übernehmen"
            icon="pi pi-check"
            :loading="busy === 'adopt'"
            @click="adoptReplay"
          />
        </div>
      </section>

      <section class="card" aria-labelledby="ae-composite">
        <h2 id="ae-composite" class="card-title">Gesamtnote ohne CLIP</h2>
        <p class="muted">
          Die „Qualität“ eines Fotos zählt bisher neben der Ästhetik auch CLIP-Schätzungen für Bildaufbau und Technik. Mit
          Q-Align steckt der Bildaufbau schon in der Ästhetik. Gespielt wird, ob eine Note aus Q-Align-Ästhetik,
          Q-Align-Technik und gemessener Schärfe die Fotos, die ihr behalten habt, öfter vorne hat. Fotos ohne
          Q-Align-Wert behalten die bisherige Formel.
        </p>
        <p class="muted">Heute: {{ weightsText(overview.settings.composite?.weights ?? null) }}.</p>
        <template v-if="composite">
          <p class="muted">
            {{ count(composite.qalign_groups) }} von {{ count(composite.decided_groups) }} entschiedenen Gruppen haben
            durchgehend Q-Align-Werte und zählen.
          </p>
          <ScrollX v-if="composite.qalign_groups > 0">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Formel</th>
                  <th scope="col" class="num">Trifft eure Wahl</th>
                  <th scope="col" class="num">Gruppen</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="v in composite.variants" :key="v.key">
                  <td>
                    {{ v.label }}
                    <Tag v-if="v.key === composite.recommended" value="Empfohlen" severity="success" />
                    <div class="muted">{{ weightsText(v.weights) }}</div>
                  </td>
                  <td class="num">{{ percent(v.hit_rate) }}</td>
                  <td class="num">{{ count(v.hits) }} / {{ count(v.groups) }}</td>
                </tr>
              </tbody>
            </table>
          </ScrollX>
          <p v-if="composite.reason" class="muted">{{ composite.reason }}</p>
        </template>
        <div class="buttons">
          <Button
            label="Nachspielen"
            icon="pi pi-replay"
            severity="secondary"
            outlined
            :loading="busy === 'composite'"
            @click="runComposite"
          />
          <Button
            v-if="compositeRecommended"
            label="Gesamtnote übernehmen"
            icon="pi pi-check"
            :loading="busy === 'composite-adopt'"
            @click="adoptComposite"
          />
          <Button
            v-if="overview.settings.composite"
            label="Bisherige Formel"
            icon="pi pi-undo"
            severity="secondary"
            text
            :loading="busy === 'composite-reset'"
            @click="resetComposite"
          />
        </div>
      </section>

      <section class="card" aria-labelledby="ae-window">
        <h2 id="ae-window" class="card-title">Zeitfenster</h2>
        <div class="field field-check">
          <ToggleSwitch v-model="enabled" input-id="ae-enabled" />
          <label for="ae-enabled">Nachts automatisch bewerten</label>
        </div>
        <div class="form">
          <div class="field">
            <label for="ae-start">Beginn</label>
            <InputText id="ae-start" v-model="windowStart" type="time" />
          </div>
          <div class="field">
            <label for="ae-end">Ende</label>
            <InputText id="ae-end" v-model="windowEnd" type="time" />
          </div>
          <Button label="Speichern" icon="pi pi-check" :loading="busy === 'save'" :disabled="!dirty" @click="save" />
        </div>
        <p class="muted">
          Im Fenster startet der Lauf, sobald das KI-Modell gerade nichts zu tun hat, und gibt die GPU spätestens zum Ende
          zurück. Uhrzeiten in {{ overview.time_zone }}; jetzt {{ overview.in_window ? 'im Fenster' : 'außerhalb' }}.
        </p>
      </section>

      <section class="card" aria-labelledby="ae-history">
        <div class="card-head">
          <h2 id="ae-history" class="card-title">Verlauf</h2>
          <Button
            v-if="anyDeletable"
            label="Verlauf leeren"
            icon="pi pi-trash"
            severity="danger"
            text
            size="small"
            :loading="busy === 'clear'"
            :disabled="busy !== null"
            @click="clearRuns"
          />
        </div>
        <EmptyState
          v-if="!overview.runs.length"
          icon="pi pi-moon"
          title="Noch kein Lauf"
          message="Der erste Lauf erscheint hier, sobald er gestartet ist."
        />
        <ScrollX v-else>
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Beginn</th>
                <th scope="col">Dauer</th>
                <th scope="col">Auslöser</th>
                <th scope="col">Status</th>
                <th scope="col" class="num">Bewertet</th>
                <th scope="col" class="num">Nicht lesbar</th>
                <th scope="col" class="num">Danach offen</th>
                <th scope="col">Ende</th>
                <th scope="col"><span class="sr-only">Aktionen</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in overview.runs" :key="r.id">
                <td class="num">{{ when(r.started_at) }}</td>
                <td class="num">{{ duration(r) }}</td>
                <td>{{ r.trigger === 'manual' ? 'von Hand' : 'Zeitfenster' }}</td>
                <td>
                  <span class="tags">
                    <Tag :value="STATUS[r.status].label" :severity="STATUS[r.status].severity" />
                    <Tag v-if="r.status !== 'running' && !r.gpu_returned" value="GPU nicht zurück" severity="warn" />
                  </span>
                </td>
                <td class="num">{{ count(r.scored) }}</td>
                <td class="num">{{ count(r.failed) }}</td>
                <td class="num">{{ r.remaining === null ? '–' : count(r.remaining) }}</td>
                <td class="reason">
                  <span v-if="r.error" class="failure">{{ r.error }}</span>
                  <span v-else>{{ r.ended_reason ?? '' }}</span>
                </td>
                <td class="row-actions">
                  <Button
                    v-if="deletable(r)"
                    icon="pi pi-trash"
                    text
                    rounded
                    size="small"
                    severity="secondary"
                    aria-label="Lauf löschen"
                    :loading="busy === r.id"
                    :disabled="busy !== null"
                    @click="deleteRun(r)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
      </section>
    </div>
  </PageLayout>
</template>

<style scoped>
.aesthetic {
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
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
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

.progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
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
  flex: 1 1 10rem;
  min-width: 0;
}

.field label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}

/* Sits in the card's column, where the field's flex-basis would be a height. */
.field-check {
  flex: none;
  flex-direction: row;
  align-items: center;
  gap: var(--space-2);
}

.field-check label {
  color: var(--p-text-color);
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

.tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  white-space: nowrap;
}

.reason {
  min-width: 12rem;
}

.table td.row-actions {
  vertical-align: middle;
  text-align: right;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
