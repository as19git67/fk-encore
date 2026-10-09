<script setup lang="ts">
/**
 * Herkunftsordner nachtragen (#1477).
 *
 * The old folder tree is mounted read-only on the server; the admin names
 * its path, the backend hashes every file in it and writes the folder onto
 * the document with the same content. "Prüfen" only reports, "Übernehmen"
 * writes — the report in between is what the admin reads before anything
 * changes.
 *
 * Hashing a real tree takes minutes, longer than a reverse proxy keeps a
 * request open, so the backend runs it in the background and this panel
 * polls its state until the report is there. A reload mid-run picks the
 * run back up, because the state lives on the server.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import {
  getSourceFolderBackfillStatus,
  startSourceFolderBackfill,
  type SourceFolderBackfillState,
} from '../../api/documents'

const POLL_MS = 2000

/** Where docker-compose.yml mounts the old tree; a bare-metal install types its own path. */
const root = ref('/mnt/data/documents-source')
const starting = ref(false)
const error = ref('')
const state = ref<SourceFolderBackfillState | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | null = null

const running = computed(() => state.value?.status === 'running')
const result = computed(() => (state.value?.status === 'done' ? state.value.result : null))
const canRun = computed(() => root.value.trim().length > 0 && !starting.value && !running.value)
const progressPercent = computed(() => {
  const p = state.value?.progress
  if (!p || p.files_found === 0) return 0
  return Math.round((p.files_hashed / p.files_found) * 100)
})

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

async function refresh() {
  stopPolling()
  try {
    state.value = await getSourceFolderBackfillStatus()
    if (state.value.status === 'failed') {
      error.value = state.value.error || 'Der Abgleich des Ordnerbaums ist fehlgeschlagen.'
    }
  } catch (err: any) {
    error.value = err?.message || 'Status des Abgleichs konnte nicht geladen werden'
    return
  }
  if (state.value.status === 'running') pollTimer = setTimeout(refresh, POLL_MS)
}

async function run(apply: boolean) {
  error.value = ''
  starting.value = true
  try {
    const { started, state: s } = await startSourceFolderBackfill(root.value.trim(), apply)
    state.value = s
    if (!started) error.value = 'Es läuft bereits ein Abgleich; das ist sein Stand.'
    if (s.status === 'running') pollTimer = setTimeout(refresh, POLL_MS)
  } catch (err: any) {
    error.value = err?.message || 'Fehler beim Abgleich des Ordnerbaums'
  } finally {
    starting.value = false
  }
}

onMounted(() => {
  void refresh().then(() => {
    if (state.value?.root) root.value = state.value.root
  })
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="data-management-group">
    <h3>Herkunftsordner nachtragen</h3>
    <p>
      Liest den alten Ordnerbaum auf dem Server, berechnet den Inhalts-Hash jeder
      PDF und trägt den Ordner bei dem Dokument ein, das dieselben Bytes hat.
      „Prüfen“ zeigt nur, was passieren würde; erst „Übernehmen“ schreibt.
    </p>

    <Message v-if="error" severity="error" class="data-management-group__item" @close="error = ''">
      {{ error }}
    </Message>

    <label class="data-management-group__item source-root">
      <span class="source-root__label">Pfad des alten Ordnerbaums auf dem Server</span>
      <InputText
        v-model="root"
        class="source-root__input"
        placeholder="/mnt/data/documents-source"
        :disabled="starting || running"
      />
    </label>

    <div class="data-management-group__item source-actions">
      <Button
        icon="pi pi-search"
        outlined
        label="Prüfen"
        :disabled="!canRun"
        :loading="(starting || running) && !state?.apply"
        @click="run(false)"
      />
      <Button
        icon="pi pi-check"
        label="Übernehmen"
        :disabled="!canRun || result === null || !result.dry_run || result.updated === 0"
        :loading="(starting || running) && !!state?.apply"
        @click="run(true)"
      />
    </div>

    <div v-if="running && state" class="data-management-group__item source-progress">
      <ProgressBar :value="progressPercent" :show-value="false" aria-label="Fortschritt des Abgleichs" />
      <span class="source-progress__text">
        {{ state.apply ? 'Übernehmen' : 'Prüfen' }} läuft:
        <template v-if="state.progress.files_found === 0">Ordnerbaum wird gelesen …</template>
        <template v-else>
          {{ state.progress.files_hashed }} von {{ state.progress.files_found }} Datei(en) gelesen.
        </template>
      </span>
    </div>

    <div v-if="result" class="data-management-group__item">
      <Message :severity="result.truncated || result.ambiguous_files_total > 0 ? 'warn' : 'info'" :closable="false">
        <template v-if="result.dry_run">Probelauf: </template>
        <template v-else>Übernommen: </template>
        {{ result.files_scanned }} Datei(en) gelesen,
        {{ result.matched }} Dokument(e) gefunden,
        {{ result.updated }} Ordner {{ result.dry_run ? 'würden geschrieben' : 'geschrieben' }}.
        {{ result.unmatched_files_total }} Datei(en) ohne Dokument,
        {{ result.unmatched_rows_total }} Dokument(e) ohne Datei im Baum.
        <template v-if="result.ambiguous_files_total > 0">
          {{ result.ambiguous_files_total }} Datei(en) liegen mit gleichem Inhalt in mehreren Ordnern und wurden ausgelassen.
        </template>
        <template v-if="result.truncated">
          Der Baum war größer als das Limit, der Bericht ist unvollständig.
        </template>
      </Message>

      <details v-if="result.matches.length > 0" class="source-report">
        <summary>Zuordnungen ({{ result.matches.length }}{{ result.matched > result.matches.length ? ` von ${result.matched}` : '' }})</summary>
        <ul class="source-report__list">
          <li v-for="m in result.matches" :key="m.document_id">
            <RouterLink :to="{ name: 'dokumente-detail', params: { id: m.document_id } }">#{{ m.document_id }}</RouterLink>
            → {{ m.source_folder ?? '(Wurzel)' }}
            <span v-if="m.previous && m.previous !== m.source_folder" class="text-secondary">(vorher {{ m.previous }})</span>
          </li>
        </ul>
      </details>

      <details v-if="result.unmatched_files.length > 0" class="source-report">
        <summary>Dateien ohne Dokument ({{ result.unmatched_files_total }})</summary>
        <ul class="source-report__list">
          <li v-for="f in result.unmatched_files" :key="f">{{ f }}</li>
        </ul>
      </details>

      <details v-if="result.ambiguous_files.length > 0" class="source-report">
        <summary>Gleicher Inhalt in mehreren Ordnern ({{ result.ambiguous_files_total }})</summary>
        <ul class="source-report__list">
          <li v-for="f in result.ambiguous_files" :key="f">{{ f }}</li>
        </ul>
      </details>
    </div>
  </div>
</template>

<style scoped>
.source-root {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.source-root__label {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.source-root__input {
  width: 100%;
  max-width: 40rem;
}
.source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.source-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-width: 40rem;
}
.source-progress__text {
  color: var(--p-text-muted-color);
  font-size: var(--text-sm);
}
.source-report {
  margin-top: var(--space-2);
}
.source-report__list {
  margin: var(--space-1) 0 0;
  padding-left: 1.25rem;
  max-height: 20rem;
  overflow: auto;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
</style>
