<script setup lang="ts">
/**
 * Duplikate (#1481): pairs of documents that read like the same document,
 * side by side, with the evidence the scan collected and one decision per
 * pair — merge (naming which side stays) or "not a duplicate". Nothing is
 * deleted by the scan itself; only a merge confirmed here removes a file.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import RadioButton from 'primevue/radiobutton'
import Tag from 'primevue/tag'
import { useConfirm } from 'primevue/useconfirm'
import AdminPage from '../components/admin/AdminPage.vue'
import DocumentThumbnail from '../components/DocumentThumbnail.vue'
import {
  dismissDuplicate,
  getDuplicateAutoMergeStatus,
  listDuplicates,
  mergeDuplicate,
  scanDuplicates,
  startDuplicateAutoMerge,
  type AutoMergeItem,
  type AutoMergeState,
  type DuplicatePair,
  type DuplicateScanResponse,
  type DuplicateSide,
  type MergeDuplicateResult,
} from '../api/documents'
import { parseLocalDate } from '../utils/dateFormat'

const router = useRouter()
const confirm = useConfirm()

const pairs = ref<DuplicatePair[]>([])
/** Open pairs above the threshold, including those beyond the page shown. */
const total = ref(0)
/** Pairs an earlier scan recorded under a lower threshold; the server hides them. */
const hiddenBelowThreshold = ref(0)
const loading = ref(false)
const error = ref('')
const scanning = ref(false)
const scanResult = ref<DuplicateScanResponse | null>(null)
const lastMerge = ref<MergeDuplicateResult | null>(null)
/** Which side the admin picked per pair; falls back to the suggested keeper. */
const keeperChoice = ref<Record<number, number>>({})
const busyPair = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await listDuplicates()
    pairs.value = res.items
    total.value = res.total
    hiddenBelowThreshold.value = res.hidden_below_threshold
  } catch (err: any) {
    error.value = err?.message || 'Duplikate konnten nicht geladen werden'
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function scan() {
  scanning.value = true
  error.value = ''
  scanResult.value = null
  try {
    scanResult.value = await scanDuplicates()
    await load()
  } catch (err: any) {
    error.value = err?.message || 'Der Scan ist fehlgeschlagen'
  } finally {
    scanning.value = false
  }
}

function keeperOf(p: DuplicatePair): number {
  return keeperChoice.value[p.id] ?? p.suggested_keeper_id
}
function loserOf(p: DuplicatePair): DuplicateSide {
  return keeperOf(p) === p.a.id ? p.b : p.a
}
function keeperSide(p: DuplicatePair): DuplicateSide {
  return keeperOf(p) === p.a.id ? p.a : p.b
}

function label(s: DuplicateSide): string {
  return s.title || s.original_filename
}

function formatDocDate(iso: string | null): string {
  if (!iso) return '–'
  return parseLocalDate(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function formatUploaded(iso: string | null): string {
  if (!iso) return '–'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
const TEXT_SOURCE_LABELS: Record<string, string> = {
  ocr: 'OCR (Scan ohne Textebene)',
  text_layer: 'Textebene vorhanden',
  mixed: 'Textebene teils, OCR teils',
}
function textSource(s: DuplicateSide): string {
  return s.text_source ? (TEXT_SOURCE_LABELS[s.text_source] ?? s.text_source) : '–'
}

function evidenceChips(p: DuplicatePair): string[] {
  const e = p.evidence
  const out: string[] = []
  out.push(`Text ${Math.round(p.score * 100)}% gleich`)
  if (e.pages_a != null && e.pages_a === e.pages_b) out.push(`${e.pages_a} Seiten beide`)
  if (e.same_date) out.push('Gleiches Datum')
  if (e.same_correspondent) out.push('Gleicher Korrespondent')
  if (e.embedding_hit) out.push('Embedding fast identisch')
  const ocrVsLayer =
    (e.text_source_a === 'ocr' && e.text_source_b === 'text_layer') ||
    (e.text_source_b === 'ocr' && e.text_source_a === 'text_layer')
  if (ocrVsLayer) out.push('Scan neben Textebenen-Kopie')
  if (e.speaking_name_a || e.speaking_name_b) out.push('Dateiname aus dem Dokumenten-Volume')
  return out
}

function open(id: number) {
  void router.push({ name: 'dokumente-detail', params: { id } })
}

function askMerge(p: DuplicatePair) {
  const keeper = keeperSide(p)
  const loser = loserOf(p)
  confirm.require({
    header: 'Duplikate zusammenführen',
    message:
      `„${label(loser)}“ (#${loser.id}) wird gelöscht. Tags, Sammelmappen, Personen, Steuerzuordnung, ` +
      `Finanzverknüpfungen und Wiedervorlagen wandern vorher zu „${label(keeper)}“ (#${keeper.id}).`,
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Zusammenführen', severity: 'danger' },
    accept: () => { void doMerge(p) },
  })
}

async function doMerge(p: DuplicatePair) {
  busyPair.value = p.id
  error.value = ''
  try {
    lastMerge.value = await mergeDuplicate(p.id, keeperOf(p))
    pairs.value = pairs.value.filter((x) => x.id !== p.id)
    total.value = Math.max(0, total.value - 1)
  } catch (err: any) {
    error.value = err?.message || 'Zusammenführen fehlgeschlagen'
  } finally {
    busyPair.value = null
  }
}

async function dismiss(p: DuplicatePair) {
  busyPair.value = p.id
  error.value = ''
  try {
    await dismissDuplicate(p.id)
    pairs.value = pairs.value.filter((x) => x.id !== p.id)
    total.value = Math.max(0, total.value - 1)
  } catch (err: any) {
    error.value = err?.message || 'Konnte das Paar nicht ablehnen'
  } finally {
    busyPair.value = null
  }
}

// ─── Automatic merge ────────────────────────────────────────────────────────

const AUTO_POLL_MS = 2000
/** Report rows rendered on the page; the CSV has them all. */
const AUTO_SHOWN_MAX = 300

const autoState = ref<AutoMergeState | null>(null)
const autoStarting = ref(false)
const autoError = ref('')
let autoTimer: ReturnType<typeof setTimeout> | null = null

const autoRunning = computed(() => autoState.value?.status === 'running')
const autoReport = computed(() => (autoState.value?.status === 'done' ? autoState.value.report : null))
const autoFound = computed(() => {
  const r = autoReport.value
  return r ? r.provenance.found + r.content.found : 0
})
const autoProgressPercent = computed(() => {
  const s = autoState.value
  if (!s || !s.apply || s.progress.found === 0) return 0
  return Math.round((s.progress.done / s.progress.found) * 100)
})

function stopAutoPolling() {
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = null
}

async function refreshAuto() {
  stopAutoPolling()
  const wasApplying = autoState.value?.status === 'running' && autoState.value.apply
  try {
    autoState.value = await getDuplicateAutoMergeStatus()
    if (autoState.value.status === 'failed') {
      autoError.value = autoState.value.error || 'Das automatische Zusammenführen ist fehlgeschlagen.'
    }
  } catch (err: any) {
    autoError.value = err?.message || 'Status des automatischen Zusammenführens konnte nicht geladen werden'
    return
  }
  if (autoState.value.status === 'running') {
    autoTimer = setTimeout(refreshAuto, AUTO_POLL_MS)
  } else if (wasApplying) {
    // The merges changed the list below.
    await load()
  }
}

async function runAuto(apply: boolean) {
  autoError.value = ''
  autoStarting.value = true
  try {
    const { started, state } = await startDuplicateAutoMerge(apply)
    autoState.value = state
    if (!started) autoError.value = 'Es läuft bereits ein Durchgang; das ist sein Stand.'
    if (state.status === 'running') autoTimer = setTimeout(refreshAuto, AUTO_POLL_MS)
  } catch (err: any) {
    autoError.value = err?.message || 'Konnte das automatische Zusammenführen nicht starten'
  } finally {
    autoStarting.value = false
  }
}

function askAutoApply() {
  const n = autoFound.value
  confirm.require({
    header: 'Automatisch zusammenführen',
    message:
      `${n} Paar(e) werden zusammengeführt; je Paar wird das exportierte bzw. jüngere Dokument gelöscht, ` +
      'nachdem Tags, Sammelmappen, Personen, Steuerzuordnung, Finanzverknüpfungen und Wiedervorlagen ' +
      'zum bleibenden Dokument gewandert sind. Das lässt sich nicht rückgängig machen.',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Abbrechen', severity: 'secondary', outlined: true },
    acceptProps: { label: `${n} Paar(e) zusammenführen`, severity: 'danger' },
    accept: () => { void runAuto(true) },
  })
}

const STAGE_LABELS: Record<AutoMergeItem['stage'], string> = {
  provenance: 'Hash im Dateinamen',
  content: 'Gleicher Inhalt',
}
const OUTCOME_LABELS: Record<AutoMergeItem['outcome'], string> = {
  planned: 'geplant',
  merged: 'zusammengeführt',
  failed: 'fehlgeschlagen',
}

const autoItemsShown = computed(() => autoReport.value?.items.slice(0, AUTO_SHOWN_MAX) ?? [])

function csvCell(v: string | number | null): string {
  const s = v == null ? '' : String(v)
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadAutoReport() {
  const r = autoReport.value
  if (!r) return
  const head = ['stufe', 'ergebnis', 'bleibt_id', 'bleibt_datei', 'geloescht_id', 'geloescht_datei', 'textscore', 'fehler']
  const lines = [head.join(';')]
  for (const i of r.items) {
    lines.push(
      [
        STAGE_LABELS[i.stage],
        OUTCOME_LABELS[i.outcome],
        i.keeper_id,
        i.keeper_filename,
        i.loser_id,
        i.loser_filename,
        i.score == null ? '' : i.score.toFixed(3),
        i.error,
      ].map(csvCell).join(';'),
    )
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `duplikate-${r.dry_run ? 'probelauf' : 'zusammengefuehrt'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(() => { void refreshAuto() })
onBeforeUnmount(stopAutoPolling)

const movedSummary = computed(() => {
  const m = lastMerge.value
  if (!m) return ''
  const moved = Object.values(m.moved).reduce((a, b) => a + b, 0)
  const dropped = Object.values(m.dropped).reduce((a, b) => a + b, 0)
  return `${moved} Verknüpfung(en) übernommen, ${dropped} bereits vorhanden oder abgeleitet`
})
</script>

<template>
  <AdminPage title="Duplikate">
    <div class="data-management-group">
      <h3>Doppelt vorhandene Dokumente</h3>
      <p>
        Der Scan vergleicht Dokumente mit gleicher Seitenzahl und gleichem Datum, Korrespondenten
        oder nahezu gleichem Embedding anhand ihres Textes. Ein Paar erscheint hier erst, wenn
        der Text zu mindestens 95&nbsp;% übereinstimmt. Gelöscht wird nichts automatisch: jedes
        Paar entscheidest du hier, und was am gelöschten Dokument hing, wandert vorher zum
        bleibenden.
      </p>

      <Message v-if="error" severity="error" class="data-management-group__item" @close="error = ''">
        {{ error }}
      </Message>

      <div v-if="scanResult" class="data-management-group__item">
        <Message severity="info" :closable="false">
          {{ scanResult.found }} Paar(e) über der Schwelle, {{ scanResult.new_open }} neu zur Prüfung,
          {{ scanResult.already_known }} bereits bekannt.
        </Message>
      </div>

      <div v-if="lastMerge" class="data-management-group__item">
        <Message severity="success" :closable="true" @close="lastMerge = null">
          #{{ lastMerge.loser_id }} in #{{ lastMerge.keeper_id }} zusammengeführt: {{ movedSummary }}.
          <template v-if="lastMerge.attributes_copied"> Geprüfte Attribute übernommen.</template>
          <template v-if="lastMerge.tax_copied"> Steuerprüfung übernommen.</template>
        </Message>
      </div>

      <Button
        class="data-management-group__item"
        icon="pi pi-search"
        outlined
        label="Bestand nach Duplikaten durchsuchen"
        :loading="scanning"
        :disabled="scanning"
        @click="scan"
      />
    </div>

    <div class="data-management-group">
      <h3>Automatisch zusammenführen</h3>
      <p>
        Zwei Arten von Paaren brauchen keinen Blick: Eine Datei, deren Name den Inhalts-Hash eines
        anderen Dokuments trägt (<code>…__0a1b2c3d.pdf</code>), wurde aus genau diesem Dokument
        exportiert und wieder importiert. Und zwei Dokumente, die in jeder Zahl, der Seitenzahl, dem
        Datum und dem Korrespondenten übereinstimmen und deren Text zu mindestens 98&nbsp;% gleich
        ist, sind derselbe Brief und nicht derselbe Vordruck mit anderen Zahlen. „Prüfen“ zählt und
        listet, „Zusammenführen“ führt genau diese Paare zusammen; das Original bleibt.
      </p>

      <Message v-if="autoError" severity="error" class="data-management-group__item" @close="autoError = ''">
        {{ autoError }}
      </Message>

      <div class="data-management-group__item auto-actions">
        <Button
          icon="pi pi-search"
          outlined
          label="Prüfen"
          :disabled="autoStarting || autoRunning"
          :loading="(autoStarting || autoRunning) && !autoState?.apply"
          @click="runAuto(false)"
        />
        <Button
          icon="pi pi-arrow-right-arrow-left"
          severity="danger"
          label="Zusammenführen"
          :disabled="autoStarting || autoRunning || !autoReport || !autoReport.dry_run || autoFound === 0"
          :loading="(autoStarting || autoRunning) && !!autoState?.apply"
          @click="askAutoApply"
        />
        <Button
          v-if="autoReport && autoReport.items.length > 0"
          icon="pi pi-download"
          text
          label="Bericht als CSV"
          @click="downloadAutoReport"
        />
      </div>

      <div v-if="autoRunning && autoState" class="data-management-group__item auto-progress">
        <ProgressBar
          :value="autoProgressPercent"
          :mode="autoState.apply ? 'determinate' : 'indeterminate'"
          :show-value="false"
          aria-label="Fortschritt des automatischen Zusammenführens"
        />
        <span class="text-secondary">
          <template v-if="autoState.apply">
            {{ autoState.progress.done }} von {{ autoState.progress.found }} Paar(en) zusammengeführt …
          </template>
          <template v-else>Paare werden gesucht … {{ autoState.progress.found }} gefunden.</template>
        </span>
      </div>

      <div v-if="autoReport" class="data-management-group__item">
        <Message :severity="autoReport.provenance.failed + autoReport.content.failed > 0 ? 'warn' : 'info'" :closable="false">
          <template v-if="autoReport.dry_run">Probelauf: </template>
          <template v-else>Übernommen: </template>
          {{ autoReport.provenance.found }} Paar(e) über den Hash im Dateinamen,
          {{ autoReport.content.found }} Paar(e) über gleichen Inhalt.
          <template v-if="!autoReport.dry_run">
            {{ autoReport.provenance.merged + autoReport.content.merged }} zusammengeführt,
            {{ autoReport.provenance.failed + autoReport.content.failed }} fehlgeschlagen.
          </template>
        </Message>

        <details v-if="autoReport.items.length > 0" class="auto-report">
          <summary>
            Paare ({{ autoItemsShown.length }}<template v-if="autoReport.items_total > autoItemsShown.length"> von {{ autoReport.items_total }}</template>)
          </summary>
          <ul class="auto-report__list">
            <li v-for="i in autoItemsShown" :key="`${i.keeper_id}-${i.loser_id}`">
              <Tag :value="STAGE_LABELS[i.stage]" severity="secondary" />
              <Tag v-if="!autoReport.dry_run" :value="OUTCOME_LABELS[i.outcome]" :severity="i.outcome === 'failed' ? 'danger' : 'success'" />
              <RouterLink :to="{ name: 'dokumente-detail', params: { id: i.keeper_id } }">#{{ i.keeper_id }}</RouterLink>
              bleibt ({{ i.keeper_filename }}),
              <template v-if="i.outcome === 'merged'">#{{ i.loser_id }}</template>
              <RouterLink v-else :to="{ name: 'dokumente-detail', params: { id: i.loser_id } }">#{{ i.loser_id }}</RouterLink>
              {{ autoReport.dry_run ? 'würde gelöscht' : 'gelöscht' }} ({{ i.loser_filename }})<template v-if="i.score != null">, Text {{ Math.round(i.score * 100) }}&nbsp;%</template>
              <span v-if="i.error" class="text-secondary"> – {{ i.error }}</span>
            </li>
          </ul>
        </details>
      </div>
    </div>

    <div class="data-management-group">
      <h3>Zur Prüfung ({{ total }})</h3>
      <p v-if="hiddenBelowThreshold > 0" class="text-secondary">
        {{ hiddenBelowThreshold }} Paar(e) aus einem früheren Scan liegen unter der heutigen
        Schwelle und werden nicht gezeigt.
      </p>
      <p v-if="loading" class="text-secondary">Wird geladen …</p>
      <p v-else-if="pairs.length === 0" class="text-secondary">
        Keine offenen Paare. Nach einem Scan oder einem Import, der wie ein vorhandenes
        Dokument liest, erscheinen sie hier.
      </p>

      <p v-else-if="total > pairs.length" class="text-secondary pair-page">
        Die {{ pairs.length }} Paare mit der höchsten Übereinstimmung werden gezeigt.
        Entschiedene Paare rücken beim Aktualisieren nach.
        <Button label="Aktualisieren" icon="pi pi-refresh" text size="small" :disabled="loading" @click="load" />
      </p>
      <ul v-if="!loading && pairs.length > 0" class="pair-list">
        <li v-for="p in pairs" :key="p.id" class="pair">
          <div class="pair__evidence">
            <Tag v-for="chip in evidenceChips(p)" :key="chip" :value="chip" severity="secondary" />
          </div>

          <div class="pair__sides">
            <div
              v-for="side in [p.a, p.b]"
              :key="side.id"
              class="side"
              :class="{ 'side--keeper': keeperOf(p) === side.id }"
            >
              <label class="side__choice">
                <RadioButton
                  :model-value="keeperOf(p)"
                  :value="side.id"
                  :input-id="`keep-${p.id}-${side.id}`"
                  :name="`keep-${p.id}`"
                  @update:model-value="keeperChoice[p.id] = side.id"
                />
                <span>{{ keeperOf(p) === side.id ? 'Bleibt' : 'Wird gelöscht' }}</span>
                <Tag v-if="p.suggested_keeper_id === side.id" value="Vorschlag" severity="info" />
              </label>
              <button type="button" class="side__thumb" :title="`#${side.id} öffnen`" @click="open(side.id)">
                <DocumentThumbnail :id="side.id" :alt="label(side)" />
              </button>
              <div class="side__facts">
                <button type="button" class="side__title" @click="open(side.id)">
                  {{ label(side) }}
                  <span class="side__id">#{{ side.id }}</span>
                </button>
                <dl class="side__meta">
                  <dt>Datei</dt><dd>{{ side.original_filename }}</dd>
                  <dt>Datum</dt><dd>{{ formatDocDate(side.doc_date) }}</dd>
                  <dt>Absender</dt><dd>{{ side.correspondent_display || side.sender || '–' }}</dd>
                  <dt>Importiert</dt><dd>{{ formatUploaded(side.uploaded_at) }}</dd>
                  <dt>Größe</dt><dd>{{ formatSize(side.size_bytes) }}<template v-if="side.pages_total != null"> · {{ side.pages_total }} Seiten</template></dd>
                  <dt>Text</dt><dd>{{ textSource(side) }}</dd>
                  <dt v-if="side.source_folder">Herkunft</dt><dd v-if="side.source_folder">{{ side.source_folder }}</dd>
                </dl>
                <div class="side__flags">
                  <Tag v-if="side.attributes_reviewed" value="Attribute geprüft" severity="success" />
                  <Tag v-if="side.tax_reviewed" value="Steuer geprüft" severity="success" />
                </div>
              </div>
            </div>
          </div>

          <div class="pair__actions">
            <Button
              label="Kein Duplikat"
              icon="pi pi-times"
              severity="secondary"
              outlined
              :disabled="busyPair === p.id"
              @click="dismiss(p)"
            />
            <Button
              label="Zusammenführen"
              icon="pi pi-arrow-right-arrow-left"
              severity="danger"
              :loading="busyPair === p.id"
              :disabled="busyPair === p.id"
              @click="askMerge(p)"
            />
          </div>
        </li>
      </ul>
    </div>
  </AdminPage>
</template>

<style scoped>
.auto-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.auto-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-width: 40rem;
}
.auto-progress span {
  font-size: var(--text-sm);
}
.auto-report {
  margin-top: var(--space-2);
}
.auto-report__list {
  margin: var(--space-1) 0 0;
  padding-left: 1.25rem;
  max-height: 24rem;
  overflow: auto;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.pair-page {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.pair-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.pair {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--p-content-border-color);
  border-radius: 8px;
  background: var(--p-content-background);
}
.pair__evidence {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.pair__sides {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-3);
}
/* Two columns from `md` up (768px, see useBreakpoint). */
@media (min-width: 768px) {
  .pair__sides {
    grid-template-columns: 1fr 1fr;
  }
}
.side {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas: "choice choice" "thumb facts";
  gap: var(--space-2);
  padding: var(--space-2);
  border-radius: 6px;
  border: 1px solid var(--p-content-border-color);
  min-width: 0;
}
.side--keeper {
  border-color: var(--p-primary-color);
  background: var(--p-content-hover-background);
}
.side__choice {
  grid-area: choice;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}
.side__thumb {
  grid-area: thumb;
  all: unset;
  cursor: pointer;
  width: 5rem;
  height: 6.5rem;
  flex: none;
}
.side__thumb:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.side__facts {
  grid-area: facts;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.side__title {
  all: unset;
  cursor: pointer;
  font-weight: 600;
  color: var(--p-text-color);
  overflow-wrap: anywhere;
}
.side__title:hover {
  text-decoration: underline;
}
.side__title:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.side__id {
  color: var(--p-text-muted-color);
  font-weight: 400;
  margin-left: 0.3em;
}
.side__meta {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.1rem var(--space-2);
  font-size: var(--text-sm);
}
.side__meta dt {
  color: var(--p-text-muted-color);
}
.side__meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.side__flags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.pair__actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
