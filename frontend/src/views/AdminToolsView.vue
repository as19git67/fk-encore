<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ToggleSwitch from 'primevue/toggleswitch'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import {
  runTool,
  cancelTool,
  getToolsStatus,
  listReports,
  downloadReport,
  type RunToolOptions,
  type ReportFile,
} from '../api/taxonomy-tools'
import { useRealtimeEvent } from '../composables/useRealtime'

interface ToolConfig {
  name: string
  label: string
  description: string
  options: {
    dry_run: boolean
    batch: number | null
    sample: number | null
    tax_sample: number | null
    focus_sections: string
    focus_categories: string
  }
}

const tools = ref<ToolConfig[]>([
  {
    name: 'diagnose',
    label: 'Diagnose',
    description:
      'Read-only Analyse: Kategorie-Verteilung, Gold-Set-Inventar, Steuer-Sektionen, Embedding-Confusion.',
    options: {
      dry_run: false,
      batch: null,
      sample: 800,
      tax_sample: null,
      focus_sections: '',
      focus_categories: '',
    },
  },
  {
    name: 'cloud-audit',
    label: 'Cloud Audit',
    description:
      'Claude klassifiziert eine Stichprobe und wird mit dem lokalen Qwen verglichen. Read-only.',
    options: {
      dry_run: false,
      batch: null,
      sample: 300,
      tax_sample: 100,
      focus_sections: '',
      focus_categories: '',
    },
  },
  {
    name: 'cloud-teacher',
    label: 'Cloud Teacher',
    description:
      'Claude labelt strategisch ausgewaehlte Dokumente und schreibt die Labels als source=cloud in die DB.',
    options: {
      dry_run: false,
      batch: 400,
      sample: null,
      tax_sample: null,
      focus_sections: '',
      focus_categories: '',
    },
  },
])

const running = ref<Record<string, boolean>>({})
const starting = ref<Record<string, boolean>>({})
const cancelling = ref<Record<string, boolean>>({})
const error = ref('')
const logs = ref<Record<string, string[]>>({})
const finishedState = ref<Record<string, 'done' | 'error' | null>>({})
const reports = ref<Record<string, ReportFile[]>>({})
const downloading = ref<Record<string, boolean>>({})

async function fetchStatus() {
  try {
    const res = await getToolsStatus()
    for (const t of res.tools) {
      running.value[t.tool] = t.running
    }
  } catch (err: any) {
    error.value = `Status: ${err?.message ?? err}`
  }
}

async function startTool(tool: ToolConfig) {
  error.value = ''
  starting.value = { ...starting.value, [tool.name]: true }
  logs.value = { ...logs.value, [tool.name]: [] }
  finishedState.value = { ...finishedState.value, [tool.name]: null }

  const opts: RunToolOptions = {}
  if (tool.options.dry_run) opts.dry_run = true
  if (tool.options.batch) opts.batch = tool.options.batch
  if (tool.options.sample) opts.sample = tool.options.sample
  if (tool.options.tax_sample) opts.tax_sample = tool.options.tax_sample
  if (tool.options.focus_sections) opts.focus_sections = tool.options.focus_sections
  if (tool.options.focus_categories) opts.focus_categories = tool.options.focus_categories

  try {
    await runTool(tool.name, opts)
    running.value = { ...running.value, [tool.name]: true }
  } catch (err: any) {
    error.value = `${tool.label}: ${err?.message ?? err}`
  } finally {
    starting.value = { ...starting.value, [tool.name]: false }
  }
}

async function stopTool(toolName: string) {
  cancelling.value = { ...cancelling.value, [toolName]: true }
  try {
    await cancelTool(toolName)
  } catch (err: any) {
    error.value = `Abbruch ${toolName}: ${err?.message ?? err}`
  } finally {
    cancelling.value = { ...cancelling.value, [toolName]: false }
  }
}

function appendLog(tool: string, message: string) {
  const current = logs.value[tool] ?? []
  current.push(message)
  // Keep last 2000 lines to avoid memory issues on long runs.
  if (current.length > 2000) current.splice(0, current.length - 2000)
  logs.value = { ...logs.value, [tool]: current }
}

async function fetchReports(toolName: string) {
  try {
    const res = await listReports(toolName)
    reports.value = { ...reports.value, [toolName]: res.files }
  } catch {
    reports.value = { ...reports.value, [toolName]: [] }
  }
}

async function doDownload(toolName: string, filename: string) {
  const key = `${toolName}/${filename}`
  downloading.value = { ...downloading.value, [key]: true }
  try {
    await downloadReport(toolName, filename)
  } catch (err: any) {
    error.value = `Download ${filename}: ${err?.message ?? err}`
  } finally {
    downloading.value = { ...downloading.value, [key]: false }
  }
}

// Realtime events from the backend relay.
useRealtimeEvent('tools', 'start', (ev) => {
  const tool = ev.resourceId
  appendLog(tool, ev.payload.message as string)
})

useRealtimeEvent('tools', 'log', (ev) => {
  const tool = ev.resourceId
  appendLog(tool, ev.payload.message as string)
})

useRealtimeEvent('tools', 'done', (ev) => {
  const tool = ev.resourceId
  appendLog(tool, ev.payload.message as string)
  running.value = { ...running.value, [tool]: false }
  finishedState.value = { ...finishedState.value, [tool]: 'done' }
  fetchReports(tool)
})

useRealtimeEvent('tools', 'error', (ev) => {
  const tool = ev.resourceId
  appendLog(tool, ev.payload.message as string)
  running.value = { ...running.value, [tool]: false }
  finishedState.value = { ...finishedState.value, [tool]: 'error' }
})

onMounted(() => {
  fetchStatus()
})
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>Taxonomie-Tools</h1>
      <Button
        icon="pi pi-refresh"
        label="Status"
        text
        size="small"
        @click="fetchStatus"
      />
    </header>

    <p class="hint">
      Offline-Werkzeuge fuer die Dokument-Taxonomie. Diagnose und Audit sind read-only;
      der Cloud-Teacher schreibt Labels in die Datenbank. Logs werden live ueber WebSocket gestreamt.
    </p>

    <Message v-if="error" severity="error" :closable="true" @close="error = ''">
      {{ error }}
    </Message>

    <div class="tools-grid">
      <div v-for="tool in tools" :key="tool.name" class="tool-card">
        <header class="tool-header">
          <div class="tool-title">
            <strong>{{ tool.label }}</strong>
            <span class="hint">{{ tool.description }}</span>
          </div>
          <Tag
            v-if="running[tool.name]"
            severity="warn"
            value="laeuft"
          />
          <Tag
            v-else-if="finishedState[tool.name] === 'done'"
            severity="success"
            value="fertig"
          />
          <Tag
            v-else-if="finishedState[tool.name] === 'error'"
            severity="danger"
            value="Fehler"
          />
        </header>

        <!-- Options -->
        <div class="tool-options">
          <div v-if="tool.name === 'cloud-audit' || tool.name === 'cloud-teacher'" class="option-row">
            <label>Dry Run</label>
            <ToggleSwitch v-model="tool.options.dry_run" :disabled="running[tool.name]" />
          </div>

          <div v-if="tool.name === 'diagnose'" class="option-row">
            <label>Confusion Sample</label>
            <InputNumber
              v-model="tool.options.sample"
              :min="0"
              :max="5000"
              :disabled="running[tool.name]"
              placeholder="800"
              class="option-input"
            />
          </div>

          <div v-if="tool.name === 'cloud-audit'" class="option-row">
            <label>Kategorie-Stichprobe</label>
            <InputNumber
              v-model="tool.options.sample"
              :min="1"
              :max="5000"
              :disabled="running[tool.name]"
              placeholder="300"
              class="option-input"
            />
          </div>

          <div v-if="tool.name === 'cloud-audit'" class="option-row">
            <label>Steuer-Stichprobe</label>
            <InputNumber
              v-model="tool.options.tax_sample"
              :min="1"
              :max="5000"
              :disabled="running[tool.name]"
              placeholder="100"
              class="option-input"
            />
          </div>

          <div v-if="tool.name === 'cloud-teacher'" class="option-row">
            <label>Batch</label>
            <InputNumber
              v-model="tool.options.batch"
              :min="1"
              :max="5000"
              :disabled="running[tool.name]"
              placeholder="400"
              class="option-input"
            />
          </div>

          <div v-if="tool.name === 'cloud-audit'" class="option-row">
            <label>Focus Sections</label>
            <InputText
              v-model="tool.options.focus_sections"
              :disabled="running[tool.name]"
              placeholder="z.B. anlage-av,anlage-kind"
              class="option-input"
            />
          </div>

          <div v-if="tool.name === 'cloud-teacher'" class="option-row">
            <label>Focus Categories</label>
            <InputText
              v-model="tool.options.focus_categories"
              :disabled="running[tool.name]"
              placeholder="z.B. finanzen-steuern,sonstiges"
              class="option-input"
            />
          </div>
        </div>

        <!-- Actions -->
        <div class="tool-actions">
          <Button
            v-if="!running[tool.name]"
            icon="pi pi-play"
            label="Starten"
            size="small"
            :loading="starting[tool.name]"
            :disabled="!!starting[tool.name]"
            @click="startTool(tool)"
          />
          <Button
            v-else
            icon="pi pi-stop"
            label="Abbrechen"
            size="small"
            severity="danger"
            :loading="cancelling[tool.name]"
            @click="stopTool(tool.name)"
          />
          <Button
            v-if="(logs[tool.name]?.length ?? 0) > 0"
            icon="pi pi-trash"
            label="Log leeren"
            size="small"
            severity="secondary"
            text
            @click="logs[tool.name] = []"
          />
        </div>

        <!-- Reports -->
        <div v-if="(reports[tool.name]?.length ?? 0) > 0" class="tool-reports">
          <span class="reports-label">Reports:</span>
          <Button
            v-for="file in reports[tool.name]"
            :key="file.name"
            :icon="downloading[`${tool.name}/${file.name}`] ? 'pi pi-spinner pi-spin' : 'pi pi-download'"
            :label="file.name"
            size="small"
            severity="secondary"
            outlined
            :disabled="!!downloading[`${tool.name}/${file.name}`]"
            @click="doDownload(tool.name, file.name)"
          />
        </div>

        <!-- Log output -->
        <div
          v-if="(logs[tool.name]?.length ?? 0) > 0"
          class="log-area"
          :ref="(el) => { if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight }"
        >
          <pre class="log-content"><template v-for="(line, i) in logs[tool.name]" :key="i">{{ line }}
</template></pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
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
.hint {
  color: var(--p-text-muted-color);
  margin: 0;
  font-size: 0.85rem;
}
.tools-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.tool-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.6rem;
  background: var(--p-content-background);
  overflow: hidden;
}
.tool-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.tool-title {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.tool-options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.option-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: 100%;
}
.option-row label {
  font-size: 0.85rem;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--p-text-muted-color);
}
.option-input {
  flex: 1 1 0;
  min-width: 0;
  max-width: 240px;
}
.tool-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.tool-reports {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.reports-label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  flex-shrink: 0;
}
.log-area {
  max-height: 400px;
  overflow-y: auto;
  overflow-x: auto;
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.4rem;
  background: rgba(0, 0, 0, 0.03);
  padding: 0.5rem;
}
@media (prefers-color-scheme: dark) {
  .log-area {
    background: rgba(255, 255, 255, 0.03);
  }
}
:root[data-theme="dark"] .log-area {
  background: rgba(255, 255, 255, 0.03);
}
:root[data-theme="light"] .log-area {
  background: rgba(0, 0, 0, 0.03);
}
.log-content {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--p-text-color);
}

@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
  .page-header h1 {
    font-size: 1.25rem;
  }
  .option-input {
    max-width: 100%;
  }
}
</style>
