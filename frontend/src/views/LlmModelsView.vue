<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import ToggleSwitch from 'primevue/toggleswitch'
import {
  activateLlmConfig,
  cancelLlmDownload,
  createLlmConfig,
  deleteLlmConfig,
  deleteLlmModelFile,
  downloadLlmModel,
  getLlmStatus,
  listLlmConfigs,
  listLlmModelFiles,
  resetLlmConfig,
  updateLlmConfig,
  type LlmConfigInput,
  type LlmConfigRow,
  type LlmStatus,
  type ModelFilesResponse,
} from '../api/llmModels'

const configs = ref<LlmConfigRow[]>([])
const status = ref<LlmStatus | null>(null)
const files = ref<ModelFilesResponse | null>(null)
const error = ref('')
const notice = ref('')
const loading = ref(false)
const busyId = ref<number | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

// A reload or a download is in flight — poll fast enough that the progress bar
// moves, slow enough that a 26 GB download does not generate thousands of
// requests. Otherwise the page is static and one poll a minute is plenty.
const isBusy = computed(() => {
  const reload = status.value?.reload.state
  const download = status.value?.download.state
  return (
    (reload !== undefined && !['idle', 'ready', 'error'].includes(reload)) ||
    download === 'downloading' ||
    download === 'verifying'
  )
})

async function refresh(showSpinner = false) {
  if (showSpinner) loading.value = true
  try {
    const [cfgs, st, fl] = await Promise.all([
      listLlmConfigs(),
      getLlmStatus().catch(() => null),
      listLlmModelFiles().catch(() => null),
    ])
    configs.value = cfgs.configs
    status.value = st
    files.value = fl
    error.value = st ? '' : 'llm-service nicht erreichbar — Konfigurationen sind trotzdem editierbar.'
  } catch (err: any) {
    error.value = err?.message ?? String(err)
  } finally {
    loading.value = false
  }
}

function schedulePoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => refresh(), isBusy.value ? 2_000 : 60_000)
}

onMounted(async () => {
  await refresh(true)
  schedulePoll()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

async function withBusy(id: number, fn: () => Promise<unknown>, success: string) {
  busyId.value = id
  error.value = ''
  notice.value = ''
  try {
    await fn()
    notice.value = success
    await refresh()
    schedulePoll()
  } catch (err: any) {
    error.value = err?.message ?? String(err)
  } finally {
    busyId.value = null
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

const confirmActivate = ref<LlmConfigRow | null>(null)

function onActivate(config: LlmConfigRow) {
  confirmActivate.value = config
}

async function doActivate() {
  const config = confirmActivate.value
  confirmActivate.value = null
  if (!config) return
  await withBusy(
    config.id,
    () => activateLlmConfig(config.id),
    `„${config.label}" wird geladen — Klassifikation ist solange nicht verfügbar.`,
  )
}

async function onReset() {
  await withBusy(-1, resetLlmConfig, 'Zurück auf die Konfiguration aus der Container-Umgebung.')
}

// ── Editor ───────────────────────────────────────────────────────────────────

const editing = ref<LlmConfigRow | null>(null)
const editorOpen = ref(false)
const form = ref<LlmConfigInput>(blankForm())

function blankForm(): LlmConfigInput {
  return {
    label: '',
    description: '',
    model_filename: '',
    model_url: '',
    model_sha256: '',
    extra_urls: [],
    backend: 'inproc',
    accelerator: 'cpu',
    ctx_size: 8192,
    gpu_layers: 0,
    threads: null,
    batch_size: 512,
    ubatch_size: 512,
    flash_attn: false,
    kv_type: 'f16',
    n_cpu_moe: 0,
    reasoning: 'off',
    server_extra_args: '',
    ready_timeout_s: 900,
    request_timeout_s: 900,
    app_timeout_ms: 120_000,
  }
}

const extraUrlsText = ref('')

function openEditor(config: LlmConfigRow | null) {
  editing.value = config
  form.value = config ? { ...config } : blankForm()
  extraUrlsText.value = (config?.extra_urls ?? []).join('\n')
  editorOpen.value = true
}

async function saveConfig() {
  const payload: LlmConfigInput = {
    ...form.value,
    extra_urls: extraUrlsText.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  }
  const target = editing.value
  await withBusy(
    target?.id ?? 0,
    () => (target ? updateLlmConfig(target.id, payload) : createLlmConfig(payload)),
    target ? 'Konfiguration gespeichert.' : 'Konfiguration angelegt.',
  )
  if (!error.value) editorOpen.value = false
}

async function onDelete(config: LlmConfigRow) {
  if (!window.confirm(`„${config.label}" löschen?`)) return
  await withBusy(config.id, () => deleteLlmConfig(config.id), 'Konfiguration gelöscht.')
}

// ── Downloads ────────────────────────────────────────────────────────────────

const downloadOpen = ref(false)
const downloadForm = ref({ url: '', filename: '', sha256: '', extra: '' })

async function startDownload() {
  await withBusy(
    -2,
    () =>
      downloadLlmModel({
        url: downloadForm.value.url.trim(),
        filename: downloadForm.value.filename.trim() || undefined,
        sha256: downloadForm.value.sha256.trim() || undefined,
        extra_urls: downloadForm.value.extra
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      }),
    'Download gestartet.',
  )
  if (!error.value) {
    downloadOpen.value = false
    downloadForm.value = { url: '', filename: '', sha256: '', extra: '' }
  }
}

async function onCancelDownload() {
  await withBusy(-2, cancelLlmDownload, 'Download abgebrochen — die Teildatei bleibt liegen.')
}

async function onDeleteFile(filename: string) {
  if (!window.confirm(`„${filename}" von der Modell-Ablage löschen?`)) return
  await withBusy(-2, () => deleteLlmModelFile(filename), `${filename} gelöscht.`)
}

// ── Formatting ───────────────────────────────────────────────────────────────

const BACKEND_OPTIONS = [
  { label: 'inproc (llama-cpp-python)', value: 'inproc' },
  { label: 'server (llama-server)', value: 'server' },
]
const ACCELERATOR_OPTIONS = [
  { label: 'CPU', value: 'cpu' },
  { label: 'CUDA', value: 'cuda' },
]
const KV_OPTIONS = ['f16', 'q8_0', 'q5_1', 'q5_0', 'q4_0'].map((v) => ({ label: v, value: v }))
const REASONING_OPTIONS = ['off', 'auto', 'think'].map((v) => ({ label: v, value: v }))

const RELOAD_LABELS: Record<string, string> = {
  idle: 'bereit',
  stopping: 'Modell wird entladen',
  downloading: 'Gewichte werden geladen',
  loading: 'Modell wird geladen',
  ready: 'bereit',
  error: 'Fehler',
}

const RELOAD_SEVERITY: Record<string, string> = {
  idle: 'success',
  stopping: 'warn',
  downloading: 'warn',
  loading: 'warn',
  ready: 'success',
  error: 'danger',
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '–'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

function formatEta(seconds: number | null): string {
  if (seconds == null) return '–'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const min = Math.round(seconds / 60)
  if (min < 60) return `${min}min`
  return `${(min / 60).toFixed(1)}h`
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>KI-Modell</h1>
      <div class="header-actions">
        <Button
          icon="pi pi-refresh"
          label="Aktualisieren"
          text
          size="small"
          :loading="loading"
          @click="refresh(true)"
        />
        <Button icon="pi pi-plus" label="Neue Konfiguration" size="small" @click="openEditor(null)" />
      </div>
    </header>

    <p class="hint">
      Legt fest, welches Modell der llm-service lädt. Solange hier nichts aktiviert ist,
      gilt die Konfiguration aus <code>docker-compose</code>/<code>.env</code> — „Auf Umgebung
      zurücksetzen" stellt diesen Zustand wieder her. Ein Modellwechsel lädt das Modell neu;
      Klassifikation ist dabei einige Minuten nicht verfügbar, Dokumente werden solange
      zurückgestellt. Einbettungen laufen unverändert weiter.
    </p>

    <Message v-if="error" severity="error" closable @close="error = ''">{{ error }}</Message>
    <Message v-if="notice" severity="success" closable @close="notice = ''">{{ notice }}</Message>

    <!-- ── Live status ───────────────────────────────────────────────────── -->
    <section v-if="status" class="card status-card">
      <header class="card-header">
        <h2>Aktuell geladen</h2>
        <Tag
          :severity="RELOAD_SEVERITY[status.reload.state] ?? 'secondary'"
          :value="RELOAD_LABELS[status.reload.state] ?? status.reload.state"
        />
      </header>

      <dl class="fields">
        <div class="field">
          <dt>Modell</dt>
          <dd><code>{{ status.live.model_filename }}</code></dd>
        </div>
        <div class="field">
          <dt>Konfiguration</dt>
          <dd>
            <template v-if="status.live.source === 'env'">
              Container-Umgebung
              <span class="hint">nichts aktiviert</span>
            </template>
            <template v-else>{{ status.live.label || 'ohne Namen' }}</template>
          </dd>
        </div>
        <div class="field">
          <dt>Backend</dt>
          <dd>{{ status.live.backend }} · {{ status.live.accelerator }}</dd>
        </div>
        <div class="field">
          <dt>Kontext</dt>
          <dd>{{ status.live.ctx_size.toLocaleString('de-DE') }} Token</dd>
        </div>
        <div class="field">
          <dt>GPU-Layer</dt>
          <dd>{{ status.live.gpu_layers === -1 ? 'alle' : status.live.gpu_layers }}</dd>
        </div>
        <div class="field">
          <dt>Experten im RAM</dt>
          <dd>{{ status.live.n_cpu_moe > 0 ? `${status.live.n_cpu_moe} Layer` : '–' }}</dd>
        </div>
      </dl>

      <Message v-if="!status.in_sync" severity="warn" :closable="false">
        Gewünscht ist <strong>{{ status.intended?.label ?? 'die Umgebung' }}</strong>, geladen ist
        <strong>{{ status.live.label || status.live.model_filename }}</strong>. Der llm-service ist
        auf die vorherige Konfiguration zurückgefallen.
        <template v-if="status.reload.detail">
          <br /><code class="error">{{ status.reload.detail }}</code>
        </template>
      </Message>

      <Message
        v-else-if="status.reload.state === 'error' && status.reload.detail"
        severity="error"
        :closable="false"
      >
        <code class="error">{{ status.reload.detail }}</code>
      </Message>

      <div v-if="isBusy" class="reload-progress">
        <ProgressBar mode="indeterminate" style="height: 0.4rem" />
        <span class="hint">
          {{ RELOAD_LABELS[status.reload.state] ?? status.reload.state }} — die Seite aktualisiert sich selbst.
        </span>
      </div>

      <div class="card-actions">
        <Button
          label="Auf Umgebung zurücksetzen"
          icon="pi pi-undo"
          severity="secondary"
          size="small"
          outlined
          :disabled="status.live.source === 'env' || busyId !== null"
          :loading="busyId === -1"
          @click="onReset"
        />
      </div>
    </section>

    <!-- ── Configurations ────────────────────────────────────────────────── -->
    <section class="group">
      <h2 class="group-title">Konfigurationen</h2>

      <div v-if="!loading && configs.length === 0" class="empty-state">
        Noch keine Konfiguration angelegt.
      </div>

      <ul class="config-list">
        <li v-for="config in configs" :key="config.id" class="card config-card">
          <header class="card-header">
            <div class="config-title">
              <strong>{{ config.label }}</strong>
              <span v-if="config.description" class="hint">{{ config.description }}</span>
            </div>
            <Tag v-if="config.is_active" severity="success" value="aktiv" />
          </header>

          <dl class="fields">
            <div class="field">
              <dt>Datei</dt>
              <dd><code>{{ config.model_filename }}</code></dd>
            </div>
            <div class="field">
              <dt>Backend</dt>
              <dd>{{ config.backend }} · {{ config.accelerator }}</dd>
            </div>
            <div class="field">
              <dt>Kontext</dt>
              <dd>{{ config.ctx_size.toLocaleString('de-DE') }}</dd>
            </div>
            <div class="field">
              <dt>Experten im RAM</dt>
              <dd>{{ config.n_cpu_moe > 0 ? `${config.n_cpu_moe} Layer` : '–' }}</dd>
            </div>
            <div class="field">
              <dt>KV-Cache</dt>
              <dd>{{ config.kv_type }}{{ config.flash_attn ? ' · FlashAttention' : '' }}</dd>
            </div>
            <div class="field">
              <dt>Timeout</dt>
              <dd>{{ Math.round(config.app_timeout_ms / 1000) }}s pro Dokument</dd>
            </div>
          </dl>

          <div class="card-actions">
            <Button
              label="Aktivieren"
              icon="pi pi-play"
              size="small"
              :disabled="config.is_active || busyId !== null || isBusy"
              :loading="busyId === config.id"
              @click="onActivate(config)"
            />
            <Button
              label="Bearbeiten"
              icon="pi pi-pencil"
              size="small"
              severity="secondary"
              outlined
              :disabled="busyId !== null"
              @click="openEditor(config)"
            />
            <Button
              label="Löschen"
              icon="pi pi-trash"
              size="small"
              severity="danger"
              text
              :disabled="config.is_active || busyId !== null"
              @click="onDelete(config)"
            />
          </div>
        </li>
      </ul>
    </section>

    <!-- ── Model files ───────────────────────────────────────────────────── -->
    <section v-if="files" class="group">
      <header class="group-header">
        <h2 class="group-title">Modelldateien</h2>
        <div class="header-actions">
          <span class="hint">
            {{ formatBytes(files.disk.free_bytes) }} frei von {{ formatBytes(files.disk.total_bytes) }}
          </span>
          <Button
            icon="pi pi-download"
            label="Modell laden"
            size="small"
            severity="secondary"
            outlined
            :disabled="files.download.state === 'downloading' || busyId !== null"
            @click="downloadOpen = true"
          />
        </div>
      </header>

      <p class="hint">
        Gewichte lassen sich vorab laden und erst später aktivieren — dann dauert der
        Modellwechsel nur noch den Ladevorgang statt zusätzlich den Download.
      </p>

      <div v-if="files.download.state !== 'idle'" class="card download-card">
        <header class="card-header">
          <strong>{{ files.download.filename || 'Download' }}</strong>
          <Tag
            :severity="files.download.state === 'error' ? 'danger' : files.download.state === 'done' ? 'success' : 'warn'"
            :value="files.download.state"
          />
        </header>
        <ProgressBar
          v-if="files.download.percent !== null"
          :value="files.download.percent"
          style="height: 0.6rem"
        />
        <ProgressBar v-else-if="files.download.state === 'downloading'" mode="indeterminate" style="height: 0.6rem" />
        <div class="download-meta hint">
          <span>{{ formatBytes(files.download.bytes_done) }} / {{ formatBytes(files.download.bytes_total) }}</span>
          <span v-if="files.download.bytes_per_second">
            {{ formatBytes(files.download.bytes_per_second) }}/s · ETA {{ formatEta(files.download.eta_seconds) }}
          </span>
          <span v-if="files.download.file_count > 1">
            Datei {{ files.download.file_index + 1 }} von {{ files.download.file_count }}
          </span>
        </div>
        <code v-if="files.download.error" class="error">{{ files.download.error }}</code>
        <div class="card-actions">
          <Button
            v-if="files.download.state === 'downloading' || files.download.state === 'verifying'"
            label="Abbrechen"
            icon="pi pi-times"
            size="small"
            severity="secondary"
            outlined
            @click="onCancelDownload"
          />
        </div>
      </div>

      <ul class="file-list">
        <li v-for="file in files.files" :key="file.filename" class="file-row">
          <div class="file-name">
            <code>{{ file.filename }}</code>
            <Tag v-if="file.filename === files.active_filename" severity="success" value="geladen" />
            <Tag v-else-if="file.partial" severity="warn" value="unvollständig" />
          </div>
          <span class="hint">{{ formatBytes(file.size_bytes) }}</span>
          <Button
            icon="pi pi-trash"
            size="small"
            severity="danger"
            text
            :disabled="file.filename === files.active_filename || busyId !== null"
            @click="onDeleteFile(file.filename)"
          />
        </li>
      </ul>
      <div v-if="files.files.length === 0" class="empty-state">Keine Modelldateien vorhanden.</div>
    </section>

    <!-- ── Activation confirm ────────────────────────────────────────────── -->
    <Dialog
      :visible="confirmActivate !== null"
      modal
      header="Modell wechseln"
      :style="{ width: '32rem' }"
      @update:visible="confirmActivate = null"
    >
      <p>
        <strong>{{ confirmActivate?.label }}</strong> wird geladen. Die Klassifikation ist
        währenddessen nicht verfügbar — je nach Modellgröße einige Minuten, bei einem noch
        nicht heruntergeladenen Modell entsprechend länger.
      </p>
      <p class="hint">
        Laufende Dokumente werden zurückgestellt und danach automatisch weiterverarbeitet.
        Schlägt das Laden fehl, kehrt der Dienst zur bisherigen Konfiguration zurück.
      </p>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="confirmActivate = null" />
        <Button label="Aktivieren" icon="pi pi-play" @click="doActivate" />
      </template>
    </Dialog>

    <!-- ── Editor ────────────────────────────────────────────────────────── -->
    <Dialog
      v-model:visible="editorOpen"
      modal
      :header="editing ? 'Konfiguration bearbeiten' : 'Neue Konfiguration'"
      :style="{ width: '46rem' }"
    >
      <div class="form">
        <h3>Modell</h3>
        <div class="form-grid">
          <label class="form-field span-2">
            <span>Name</span>
            <InputText v-model="form.label" placeholder="z. B. Qwen3-14B (CUDA)" />
          </label>
          <label class="form-field span-2">
            <span>Beschreibung</span>
            <InputText v-model="form.description as string" />
          </label>
          <label class="form-field span-2">
            <span>Dateiname</span>
            <InputText v-model="form.model_filename" placeholder="Qwen3-14B-Q4_K_M.gguf" />
            <small class="hint">Reiner Dateiname, wird in der Modell-Ablage gesucht.</small>
          </label>
          <label class="form-field span-2">
            <span>Download-URL</span>
            <InputText v-model="form.model_url as string" placeholder="https://huggingface.co/…" />
            <small class="hint">Wird nur benutzt, wenn die Datei fehlt.</small>
          </label>
          <label class="form-field span-2">
            <span>SHA256 (optional)</span>
            <InputText v-model="form.model_sha256 as string" />
          </label>
          <label class="form-field span-2">
            <span>Weitere Shards (eine URL pro Zeile)</span>
            <Textarea v-model="extraUrlsText" rows="2" autoResize />
          </label>
        </div>

        <h3>Inferenz</h3>
        <div class="form-grid">
          <label class="form-field">
            <span>Backend</span>
            <Select v-model="form.backend" :options="BACKEND_OPTIONS" optionLabel="label" optionValue="value" />
          </label>
          <label class="form-field">
            <span>Beschleuniger</span>
            <Select v-model="form.accelerator" :options="ACCELERATOR_OPTIONS" optionLabel="label" optionValue="value" />
          </label>
          <label class="form-field">
            <span>Kontext (Token)</span>
            <InputNumber v-model="form.ctx_size" :min="512" :max="1048576" showButtons />
          </label>
          <label class="form-field">
            <span>GPU-Layer</span>
            <InputNumber v-model="form.gpu_layers" :min="-1" showButtons />
            <small class="hint">−1 = alle</small>
          </label>
          <label class="form-field">
            <span>Batch</span>
            <InputNumber v-model="form.batch_size" :min="1" showButtons />
          </label>
          <label class="form-field">
            <span>Micro-Batch</span>
            <InputNumber v-model="form.ubatch_size" :min="1" showButtons />
          </label>
          <label class="form-field">
            <span>Threads</span>
            <InputNumber v-model="form.threads as number" :min="0" showButtons />
            <small class="hint">0 = automatisch</small>
          </label>
          <label class="form-field">
            <span>KV-Cache</span>
            <Select v-model="form.kv_type" :options="KV_OPTIONS" optionLabel="label" optionValue="value" />
            <small class="hint">q8_0 halbiert den KV-Speicher, braucht FlashAttention.</small>
          </label>
          <div class="form-field switch-field">
            <span>FlashAttention</span>
            <ToggleSwitch v-model="form.flash_attn as boolean" />
          </div>
        </div>

        <h3>llama-server</h3>
        <p class="hint">Nur wirksam mit Backend <code>server</code>.</p>
        <div class="form-grid">
          <label class="form-field">
            <span>Experten im RAM (Layer)</span>
            <InputNumber v-model="form.n_cpu_moe" :min="0" showButtons />
            <small class="hint">0 = aus. Für MoE-Modelle so weit senken, bis die Karte fast voll ist.</small>
          </label>
          <label class="form-field">
            <span>Reasoning</span>
            <Select v-model="form.reasoning" :options="REASONING_OPTIONS" optionLabel="label" optionValue="value" />
          </label>
          <label class="form-field">
            <span>Ladezeit-Limit (s)</span>
            <InputNumber v-model="form.ready_timeout_s" :min="1" showButtons />
          </label>
          <label class="form-field">
            <span>Anfrage-Limit (s)</span>
            <InputNumber v-model="form.request_timeout_s" :min="1" showButtons />
          </label>
          <label class="form-field span-2">
            <span>Zusätzliche Argumente</span>
            <InputText v-model="form.server_extra_args as string" placeholder="--override-tensor …" />
          </label>
        </div>

        <h3>Anwendung</h3>
        <div class="form-grid">
          <label class="form-field span-2">
            <span>Timeout pro Dokument (ms)</span>
            <InputNumber v-model="form.app_timeout_ms" :min="1000" :step="10000" showButtons />
            <small class="hint">
              Muss unter dem Anfrage-Limit bleiben, damit die App zuerst aufgibt und keine
              Generierung ins Leere läuft.
            </small>
          </label>
        </div>
      </div>

      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="editorOpen = false" />
        <Button label="Speichern" icon="pi pi-check" :loading="busyId !== null" @click="saveConfig" />
      </template>
    </Dialog>

    <!-- ── Download ──────────────────────────────────────────────────────── -->
    <Dialog v-model:visible="downloadOpen" modal header="Modell laden" :style="{ width: '40rem' }">
      <div class="form-grid">
        <label class="form-field span-2">
          <span>URL</span>
          <InputText v-model="downloadForm.url" placeholder="https://huggingface.co/…/model.gguf" />
        </label>
        <label class="form-field span-2">
          <span>Dateiname (optional)</span>
          <InputText v-model="downloadForm.filename" />
          <small class="hint">Leer lassen, um den Namen aus der URL zu übernehmen.</small>
        </label>
        <label class="form-field span-2">
          <span>SHA256 (optional)</span>
          <InputText v-model="downloadForm.sha256" />
        </label>
        <label class="form-field span-2">
          <span>Weitere Shards (eine URL pro Zeile)</span>
          <Textarea v-model="downloadForm.extra" rows="2" autoResize />
        </label>
      </div>
      <template #footer>
        <Button label="Abbrechen" severity="secondary" text @click="downloadOpen = false" />
        <Button
          label="Download starten"
          icon="pi pi-download"
          :disabled="!downloadForm.url.trim()"
          :loading="busyId === -2"
          @click="startDownload"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.5rem;
  max-width: 1280px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.page-header h1 {
  margin: 0;
  font-size: 1.5rem;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
  font-size: 0.85rem;
}
.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
  border: 1px dashed var(--p-content-border-color);
  border-radius: 0.5rem;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.6rem;
  background: var(--p-content-background);
}
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.card-header h2 {
  margin: 0;
  font-size: 1.05rem;
}
.card-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.group-title {
  margin: 0;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.5rem 1rem;
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.field dt {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-muted-color);
}
.field dd {
  margin: 0;
  word-break: break-word;
}
.config-list,
.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.config-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 0.75rem;
}
.config-title {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.file-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.6rem;
  overflow: hidden;
}
.file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-content-border-color);
}
.file-row:last-child {
  border-bottom: none;
}
.file-row:hover {
  background: var(--p-content-hover-background);
}
.file-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  flex: 1;
}
.file-name code {
  word-break: break-all;
}
.download-meta {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}
.reload-progress {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.error {
  color: var(--p-red-500, #ef4444);
  word-break: break-word;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.form h3 {
  margin: 0.75rem 0 0;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 0.75rem;
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.form-field > span {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.form-field.span-2 {
  grid-column: 1 / -1;
}
.switch-field {
  justify-content: flex-start;
}
</style>
