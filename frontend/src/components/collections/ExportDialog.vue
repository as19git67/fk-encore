<script setup lang="ts">
/**
 * "Exportieren" for any collection, the basket included (#1548, stage 6).
 *
 * The dialog shows one block per kind the collection holds — documents,
 * bookings, photos, albums, securities, meters — with that kind's format and
 * options, and says what comes out: one file when a single kind fits in one,
 * a ZIP with a folder per kind and a table of contents otherwise.
 *
 * The options can be kept as a named profile with the collection, so the
 * next export is one click. Runs happen on the server; the dialog lists the
 * reader's recent ones and offers the file as long as it is kept (a week).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import {
  ENTITY_LABELS,
  EXPORT_SKIP_REASONS,
  TRANSACTION_COLUMN_LABELS,
  TRANSACTION_EXPORT_COLUMNS,
  deleteCollectionExportRun,
  deleteExportProfile,
  fetchCollectionExportFile,
  getCollectionExportRun,
  getExportSetup,
  listCollectionSends,
  listCollectionExportRuns,
  saveCollectionExportAsDocument,
  saveExportProfile,
  startCollectionExportRun,
  type ExportGroup,
  type ExportOptions,
  type ExportRun,
  type ExportSetup,
  type CollectionSend,
  type TableFormat,
  type TransactionExportColumn,
} from '../../api/collections'
import { useAuthStore } from '../../stores/auth'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'
import { triggerDownload } from '../../utils/shareFile'
import ExportSendPanel from './ExportSendPanel.vue'

const props = defineProps<{
  visible: boolean
  collectionId: number | null
  /** Shown in the header. */
  name: string
}>()
const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

const auth = useAuthStore()
const setup = ref<ExportSetup | null>(null)
const options = ref<ExportOptions | null>(null)
const profileId = ref<number | null>(null)
const runs = ref<ExportRun[]>([])
const loading = ref(false)
const starting = ref(false)
const error = ref('')
const info = ref('')
const profileName = ref('')
const naming = ref(false)
const busyRun = ref<number | null>(null)
/** The run whose "Weitergeben" panel is open (#1548, stage 7). */
const sendFor = ref<number | null>(null)
const sends = ref<CollectionSend[]>([])
const mailConfigured = ref(false)

async function loadSends() {
  if (props.collectionId === null) return
  try {
    const res = await listCollectionSends(props.collectionId)
    sends.value = res.items
    mailConfigured.value = res.mail_configured
  } catch {
    /* the log is an extra */
  }
}

function sendLabel(s: CollectionSend): string {
  const how = s.mode === 'link' ? 'als Link' : s.mode === 'items' ? 'einzeln angehängt' : 'angehängt'
  return `${s.recipients.join(', ')} · ${how}`
}

const TABLE_FORMATS: Array<{ label: string; value: TableFormat }> = [
  { label: 'PDF', value: 'pdf' },
  { label: 'Excel', value: 'xlsx' },
  { label: 'CSV', value: 'csv' },
]
const DOCUMENT_FORMATS = [
  { label: 'Ein PDF', value: 'pdf' },
  { label: 'Originale (ZIP)', value: 'zip' },
]
const PHOTO_SIZES = [
  { label: 'Original', value: 'original' },
  { label: 'Groß (2560 px)', value: 'large' },
]
const GROUP_ORDER: ExportGroup[] = ['document', 'transaction', 'photo', 'album', 'security', 'meter']

const groups = computed(() =>
  GROUP_ORDER.filter((g) => (setup.value?.groups[g] ?? 0) > 0).map((g) => ({
    key: g,
    count: setup.value!.groups[g]!,
    label: g === 'meter' ? 'Zähler und Zählerstände' : ENTITY_LABELS[g].plural,
    icon: ENTITY_LABELS[g].icon,
  })),
)

const singleFile = computed(() => {
  const o = options.value
  if (!o || groups.value.length !== 1) return false
  const only = groups.value[0]!.key
  if (only === 'photo' || only === 'album') return false
  if (only === 'document') return o.document.format === 'pdf'
  return true
})

const outcome = computed(() => {
  if (!options.value || groups.value.length === 0) return ''
  if (singleFile.value && !options.value.always_zip) return 'Ergebnis: eine Datei.'
  return 'Ergebnis: ein ZIP mit einem Ordner je Art und einem Inhaltsverzeichnis (PDF und CSV), das auch nennt, was fehlt.'
})

const profileOptions = computed(() => [
  { label: 'Eigene Einstellungen', value: null as number | null },
  ...(setup.value?.profiles ?? []).map((p) => ({ label: p.name, value: p.id as number | null })),
])

const accountsInOrder = computed(() => {
  const accounts = setup.value?.accounts ?? []
  const order = options.value?.transaction.account_order ?? []
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...accounts].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.label.localeCompare(b.label, 'de'),
  )
})

const canFileAsDocument = computed(() => auth.hasPermission('documents.upload'))

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function load() {
  if (props.collectionId === null) return
  loading.value = true
  error.value = ''
  info.value = ''
  try {
    const [s, r] = await Promise.all([getExportSetup(props.collectionId), listCollectionExportRuns(props.collectionId)])
    setup.value = s
    runs.value = r.items
    void loadSends()
    const first = s.profiles[0] ?? null
    profileId.value = first?.id ?? null
    options.value = clone(first?.options ?? s.defaults)
    poll()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Export konnte nicht vorbereitet werden.'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (open) => {
    if (open) void load()
    else stopPolling()
  },
  { immediate: true },
)

watch(profileId, (id) => {
  const profile = setup.value?.profiles.find((p) => p.id === id)
  if (profile) options.value = clone(profile.options)
})

// ── Columns, account order, period ──────────────────────────────────────────

function hasColumn(c: TransactionExportColumn): boolean {
  return options.value?.transaction.columns.includes(c) ?? false
}

function toggleColumn(c: TransactionExportColumn) {
  const tx = options.value!.transaction
  const next = hasColumn(c) ? tx.columns.filter((x) => x !== c) : [...tx.columns, c]
  if (next.length === 0) return
  tx.columns = TRANSACTION_EXPORT_COLUMNS.filter((x) => next.includes(x))
}

function moveAccount(index: number, delta: number) {
  const ids = accountsInOrder.value.map((a) => a.id)
  const target = index + delta
  if (target < 0 || target >= ids.length) return
  ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
  options.value!.transaction.account_order = ids
}

const meterFrom = computed({
  get: () => (options.value?.meter.from ? parseLocalDate(options.value.meter.from) : null),
  set: (d: Date | null) => {
    options.value!.meter.from = d ? toLocalIsoDate(d) : null
  },
})
const meterTo = computed({
  get: () => (options.value?.meter.to ? parseLocalDate(options.value.meter.to) : null),
  set: (d: Date | null) => {
    options.value!.meter.to = d ? toLocalIsoDate(d) : null
  },
})

// ── Profiles ────────────────────────────────────────────────────────────────

async function saveProfile() {
  const name = profileName.value.trim()
  if (!name || props.collectionId === null || !options.value) return
  try {
    const saved = await saveExportProfile(props.collectionId, name, options.value)
    const rest = (setup.value?.profiles ?? []).filter((p) => p.id !== saved.id)
    setup.value = { ...setup.value!, profiles: [...rest, saved].sort((a, b) => a.name.localeCompare(b.name, 'de')) }
    profileId.value = saved.id
    naming.value = false
    profileName.value = ''
    info.value = `Profil „${saved.name}“ gespeichert.`
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Profil konnte nicht gespeichert werden.'
  }
}

async function removeProfile() {
  if (props.collectionId === null || profileId.value === null) return
  const id = profileId.value
  try {
    await deleteExportProfile(props.collectionId, id)
    setup.value = { ...setup.value!, profiles: setup.value!.profiles.filter((p) => p.id !== id) }
    profileId.value = null
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Profil konnte nicht gelöscht werden.'
  }
}

// ── Runs ────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

/** Ask again while a run is still going. */
function poll() {
  stopPolling()
  if (!runs.value.some((r) => r.status === 'running')) return
  timer = setTimeout(async () => {
    const running = runs.value.filter((r) => r.status === 'running')
    const fresh = await Promise.all(running.map((r) => getCollectionExportRun(r.id).catch(() => r)))
    const byId = new Map(fresh.map((r) => [r.id, r]))
    runs.value = runs.value.map((r) => byId.get(r.id) ?? r)
    poll()
  }, 1500)
}

onBeforeUnmount(stopPolling)

async function start() {
  if (props.collectionId === null || !options.value) return
  starting.value = true
  error.value = ''
  info.value = ''
  try {
    const profile = setup.value?.profiles.find((p) => p.id === profileId.value)
    // A profile changed in the dialog runs with what is shown, not what is stored.
    const unchanged = profile && JSON.stringify(profile.options) === JSON.stringify(options.value)
    const run = await startCollectionExportRun(
      props.collectionId,
      unchanged ? { profile_id: profile.id } : { options: options.value },
    )
    runs.value = [run, ...runs.value.filter((r) => r.id !== run.id)].slice(0, 5)
    poll()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Export konnte nicht gestartet werden.'
  } finally {
    starting.value = false
  }
}

async function download(run: ExportRun) {
  busyRun.value = run.id
  try {
    const file = await fetchCollectionExportFile(run)
    const url = URL.createObjectURL(file)
    triggerDownload(url, file.name)
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Download fehlgeschlagen.'
  } finally {
    busyRun.value = null
  }
}

async function fileAsDocument(run: ExportRun) {
  busyRun.value = run.id
  try {
    const saved = await saveCollectionExportAsDocument(run.id)
    runs.value = runs.value.map((r) => (r.id === run.id ? { ...r, document_id: saved.document_id } : r))
    info.value = saved.already_existed
      ? 'Diese Datei liegt schon bei den Dokumenten.'
      : 'Als Dokument abgelegt; es wird jetzt wie jedes andere eingeordnet.'
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Ablegen fehlgeschlagen.'
  } finally {
    busyRun.value = null
  }
}

async function removeRun(run: ExportRun) {
  try {
    await deleteCollectionExportRun(run.id)
    runs.value = runs.value.filter((r) => r.id !== run.id)
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Löschen fehlgeschlagen.'
  }
}

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

function skippedLabel(run: ExportRun): string {
  return run.skipped
    .map((s) => `${ENTITY_LABELS[s.entity_type].singular} #${s.entity_id}: ${EXPORT_SKIP_REASONS[s.reason] ?? s.reason}`)
    .join('\n')
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    :header="`Exportieren: ${name}`"
    @update:visible="emit('update:visible', $event)"
  >
    <!-- The dialog body scrolls and clips; this gives the focus ring of the
         first control room inside it. -->
    <div class="exp-body">
    <Message v-if="error" severity="error" :closable="true" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" :closable="true" @close="info = ''">{{ info }}</Message>

    <p v-if="loading" class="exp-hint"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> Wird vorbereitet …</p>
    <p v-else-if="setup && groups.length === 0" class="exp-hint">Die Mappe enthält nichts, was du exportieren kannst.</p>

    <template v-else-if="options && setup">
      <div class="exp-profile">
        <label class="exp-label" for="export-profile">Profil</label>
        <Select v-model="profileId" input-id="export-profile" :options="profileOptions" option-label="label" option-value="value" class="exp-grow" />
        <Button
          v-if="profileId !== null"
          icon="pi pi-trash"
          text
          rounded
          severity="danger"
          aria-label="Profil löschen"
          v-tooltip.bottom="'Profil löschen'"
          @click="removeProfile"
        />
      </div>

      <section v-for="g in groups" :key="g.key" class="exp-group" :data-testid="`export-group-${g.key}`">
        <h3 class="exp-group-title"><i :class="g.icon" aria-hidden="true" /> {{ g.label }} ({{ g.count }})</h3>

        <template v-if="g.key === 'document'">
          <SelectButton v-model="options.document.format" :options="DOCUMENT_FORMATS" option-label="label" option-value="value" :allow-empty="false" aria-label="Format der Dokumente" />
          <p class="exp-hint">
            {{ options.document.format === 'pdf'
              ? 'Alle Dokumente in einem PDF, mit der Seitenauswahl und den Schwärzungen der Mappe.'
              : 'Die Dateien wie hochgeladen. Dokumente mit Schwärzungen bleiben draußen, sie gibt es nur im PDF.' }}
          </p>
        </template>

        <template v-else-if="g.key === 'transaction'">
          <SelectButton v-model="options.transaction.format" :options="TABLE_FORMATS" option-label="label" option-value="value" :allow-empty="false" aria-label="Format der Buchungen" />
          <label class="exp-check">
            <Checkbox v-model="options.transaction.group_by_account" binary />
            <span>Nach Konto gruppieren, mit Summe je Konto</span>
          </label>
          <div class="exp-columns" role="group" aria-label="Spalten">
            <button
              v-for="c in TRANSACTION_EXPORT_COLUMNS"
              :key="c"
              type="button"
              class="exp-chip"
              :class="{ 'exp-chip--on': hasColumn(c) }"
              :aria-pressed="hasColumn(c)"
              @click="toggleColumn(c)"
            >
              {{ TRANSACTION_COLUMN_LABELS[c] }}
            </button>
          </div>
          <ol v-if="options.transaction.group_by_account && accountsInOrder.length > 1" class="exp-accounts" aria-label="Reihenfolge der Konten">
            <li v-for="(a, i) in accountsInOrder" :key="a.id">
              <span class="exp-grow">{{ a.label }}</span>
              <Button icon="pi pi-arrow-up" text rounded size="small" :disabled="i === 0" :aria-label="`${a.label} nach oben`" @click="moveAccount(i, -1)" />
              <Button icon="pi pi-arrow-down" text rounded size="small" :disabled="i === accountsInOrder.length - 1" :aria-label="`${a.label} nach unten`" @click="moveAccount(i, 1)" />
            </li>
          </ol>
          <p class="exp-hint">Eine Auswahl ist kein Kontoauszug: Die Summen gelten nur für die Buchungen in der Mappe.</p>
        </template>

        <template v-else-if="g.key === 'photo' || g.key === 'album'">
          <SelectButton v-model="options[g.key].size" :options="PHOTO_SIZES" option-label="label" option-value="value" :allow-empty="false" :aria-label="`Größe der ${g.label}`" />
          <label class="exp-check">
            <Checkbox v-model="options[g.key].strip_metadata" binary />
            <span>Metadaten entfernen (Aufnahmeort, Kamera)</span>
          </label>
          <p v-if="g.key === 'album'" class="exp-hint">Ein Ordner je Album mit den Fotos darin, die du sehen darfst.</p>
        </template>

        <template v-else-if="g.key === 'security'">
          <SelectButton v-model="options.security.format" :options="TABLE_FORMATS" option-label="label" option-value="value" :allow-empty="false" aria-label="Format der Wertpapiere" />
          <p class="exp-hint">Bestand laut letztem Depotauszug, Kurs aus dem Kurs-Cache.</p>
        </template>

        <template v-else-if="g.key === 'meter'">
          <SelectButton v-model="options.meter.format" :options="TABLE_FORMATS" option-label="label" option-value="value" :allow-empty="false" aria-label="Format der Zählerstände" />
          <div class="exp-period">
            <label class="exp-label" for="export-meter-from">Von</label>
            <DatePicker v-model="meterFrom" input-id="export-meter-from" date-format="dd.mm.yy" show-button-bar placeholder="Anfang" />
            <label class="exp-label" for="export-meter-to">Bis</label>
            <DatePicker v-model="meterTo" input-id="export-meter-to" date-format="dd.mm.yy" show-button-bar placeholder="heute" />
          </div>
        </template>
      </section>

      <label v-if="singleFile" class="exp-check">
        <Checkbox v-model="options.always_zip" binary />
        <span>Trotzdem als ZIP, mit Inhaltsverzeichnis</span>
      </label>
      <p class="exp-hint">{{ outcome }}</p>

      <div class="exp-save">
        <template v-if="naming">
          <InputText v-model="profileName" placeholder="Name des Profils" aria-label="Name des Profils" class="exp-grow" @keyup.enter="saveProfile" />
          <Button label="Speichern" size="small" :disabled="!profileName.trim()" @click="saveProfile" />
          <Button label="Abbrechen" size="small" text severity="secondary" @click="naming = false" />
        </template>
        <Button v-else label="Als Profil speichern" icon="pi pi-bookmark" size="small" text @click="naming = true" />
      </div>
    </template>

    <section v-if="runs.length > 0" class="exp-runs" aria-label="Letzte Exporte">
      <h3 class="exp-group-title">Letzte Exporte</h3>
      <ul>
        <li v-for="run in runs" :key="run.id" class="exp-run" :data-testid="`export-run-${run.status}`">
          <div class="exp-run-body">
            <span class="exp-run-title">
              <i
                :class="run.status === 'running' ? 'pi pi-spin pi-spinner' : run.status === 'done' ? 'pi pi-file' : 'pi pi-exclamation-triangle'"
                aria-hidden="true"
              />
              {{ run.status === 'running' ? 'Wird erstellt …' : run.filename ?? 'Export fehlgeschlagen' }}
            </span>
            <span class="exp-run-meta">
              {{ timeLabel(run.started_at) }}
              <template v-if="run.status === 'done'"> · {{ sizeLabel(run.size_bytes) }} · {{ run.item_count }} Einträge</template>
              <span v-if="run.skipped.length > 0" v-tooltip.bottom="skippedLabel(run)" class="exp-run-skipped">
                · {{ run.skipped.length }} nicht enthalten
              </span>
            </span>
            <span v-if="run.status === 'failed' && run.error" class="exp-run-error">{{ run.error }}</span>
          </div>
          <div class="exp-run-actions">
            <Button
              v-if="run.status === 'done'"
              icon="pi pi-download"
              text
              rounded
              :loading="busyRun === run.id"
              :aria-label="`Herunterladen: ${run.filename}`"
              v-tooltip.bottom="'Herunterladen'"
              @click="download(run)"
            />
            <Button
              v-if="run.status === 'done' && run.mime_type === 'application/pdf' && canFileAsDocument"
              :icon="run.document_id ? 'pi pi-check' : 'pi pi-file-import'"
              text
              rounded
              :disabled="run.document_id !== null || busyRun === run.id"
              :aria-label="run.document_id ? 'Liegt bei den Dokumenten' : 'Als Dokument ablegen'"
              v-tooltip.bottom="run.document_id ? 'Liegt bei den Dokumenten' : 'Als Dokument ablegen'"
              @click="fileAsDocument(run)"
            />
            <Button
              v-if="run.status === 'done'"
              icon="pi pi-send"
              text
              rounded
              :severity="sendFor === run.id ? undefined : 'secondary'"
              :aria-expanded="sendFor === run.id"
              :aria-label="`Weitergeben: ${run.filename}`"
              v-tooltip.bottom="'Weitergeben: teilen, mailen, Link'"
              data-testid="export-run-send"
              @click="sendFor = sendFor === run.id ? null : run.id"
            />
            <Button
              v-if="run.status !== 'running'"
              icon="pi pi-times"
              text
              rounded
              severity="secondary"
              aria-label="Export entfernen"
              v-tooltip.bottom="'Entfernen'"
              @click="removeRun(run)"
            />
          </div>
          <ExportSendPanel
            v-if="sendFor === run.id && run.status === 'done'"
            class="exp-run-send"
            :run="run"
            :mail-configured="mailConfigured"
            @sent="loadSends"
          />
        </li>
      </ul>
    </section>

    <section v-if="sends.length > 0" class="exp-runs" aria-label="Versendet">
      <h3 class="exp-group-title">Versendet</h3>
      <ul>
        <li v-for="s in sends" :key="s.id" class="exp-run">
          <div class="exp-run-body">
            <span class="exp-run-title">
              <i :class="s.status === 'sent' ? 'pi pi-envelope' : 'pi pi-exclamation-triangle'" aria-hidden="true" />
              {{ s.filename ?? 'Export' }}
            </span>
            <span class="exp-run-meta">{{ timeLabel(s.sent_at) }} · {{ s.sent_by ?? '' }} → {{ sendLabel(s) }}</span>
            <span v-if="s.status === 'failed' && s.error" class="exp-run-error">{{ s.error }}</span>
          </div>
        </li>
      </ul>
    </section>
    </div>

    <template #footer>
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
      <Button
        label="Exportieren"
        icon="pi pi-download"
        :loading="starting"
        :disabled="!options || groups.length === 0"
        data-testid="export-start"
        @click="start"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.exp-body {
  /* Room above the first control; the dialog body clips at its top edge. */
  padding-top: var(--focus-ring-reach);
}
.exp-hint {
  margin: var(--space-1) 0 var(--space-2);
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.exp-label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.exp-grow {
  flex: 1 1 auto;
  min-width: 0;
}
.exp-profile,
.exp-save,
.exp-period {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.exp-profile {
  margin-bottom: var(--space-3);
}
.exp-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--p-content-border-color);
}
.exp-group-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.exp-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.exp-columns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.exp-chip {
  border: 1px solid var(--p-content-border-color);
  border-radius: 999px;
  padding: 2px 10px;
  background: var(--p-content-background);
  color: var(--p-text-muted-color);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}
.exp-chip--on {
  border-color: var(--p-primary-color);
  color: var(--p-text-color);
  background: var(--p-content-hover-background);
}
.exp-chip:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.exp-accounts {
  list-style: none;
  margin: 0;
  padding: 0;
  width: 100%;
}
.exp-accounts li {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
}
.exp-runs {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--p-content-border-color);
}
.exp-runs ul {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.exp-run {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.exp-run-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.exp-run-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exp-run-title i {
  margin-right: var(--space-1);
}
.exp-run-meta,
.exp-run-error {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.exp-run-error {
  color: var(--p-red-500);
}
.exp-run-skipped {
  text-decoration: underline dotted;
}
.exp-run-actions {
  display: flex;
  flex: 0 0 auto;
}
.exp-run-send {
  flex: 1 0 100%;
}
</style>
